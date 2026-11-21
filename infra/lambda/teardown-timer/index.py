"""Teardown timer: delete the session's stacks when nobody did.

WHY: Phase 1's cluster ran 23 hours unnoticed and cost $27.17
(docs/COST.md). Every guard before this one (the preflight, `make
aws-down`, the audit) needs a person at the keyboard. This one does not.

HOW: a schedule runs this every 15 minutes, forever. Each run:
    1. looks up the workload stacks; if none exist it does nothing
    2. works out the deadline
    3. before the deadline: waits, and warns once by email near the end
    4. after it: asks CloudFormation to delete the stacks, in order, and
        keeps asking on every run until they are gone

The deadline needs no arming step. It defaults to DEFAULT_HOURS after the
oldest stack was created, so a hand-run `cdk deploy` is covered too.
`make aws-extend` writes a later deadline to a parameter; it is capped at
MAX_HOURS after creation so a typo cannot switch the timer off. There is
no off switch on purpose.

WHAT IT DOES NOT DO: clean up what the cluster's controllers created
(load balancer, buckets, DNS records). That needs wide delete rights,
which should not sit permanently in a shared account. Deleting the stacks
stops the cluster, Fargate and NAT (about 90% of the hourly cost). A load
balancer can keep the VPC stack in DELETE_FAILED at about $0.04/h; the
email says so, and `make aws-down` finishes the job.

Alternative rejected: run the full `make aws-down` in CodeBuild at the
deadline. Complete, but a standing role with broad delete rights that
runs whatever is on the main branch.

decide() is pure (no AWS) and is what the unit tests exercise.
"""

import json
import os
from datetime import datetime, timedelta, timezone

IN_PROGRESS = "DELETE_IN_PROGRESS"
FAILED = "DELETE_FAILED"
WARN_FROM_MIN = 30  # warn when between 30 and 15 minutes remain:
WARN_TO_MIN = 15  # exactly one 15-minute run lands in that window
STUCK_REMINDER_MIN = 24 * 60


def parse_time(text):
    """ISO-8601 to an aware datetime, or None if it is not one."""
    try:
        t = datetime.fromisoformat(str(text).strip().replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def decide(now, stacks, groups, param, default_hours, max_hours):
    """Decide what one run should do. No AWS calls.

    now      aware datetime
    stacks   {name: {"status": str, "created": datetime}} for stacks that exist
    groups   [[names], [names], ...]; a group is deleted only once the
            groups before it are gone or stuck (they depend on later ones)
    param    the deadline parameter's text, or None if it is not set

    Returns {"state", "deadline", "delete", "set_param", "clear_param", "notify"}.
    """
    out = {"state": "idle", "deadline": None, "delete": [], "set_param": None, "clear_param": False, "notify": None}
    if not stacks:
        if param is not None:
            # The parameter is left behind by a teardown or an extension.
            out["clear_param"] = True
            out["notify"] = ("IDP: all session stacks are gone", "No workload stacks exist any more. Run `make aws-audit` to confirm nothing else is billing.")
        return out

    created = min(s["created"] for s in stacks.values())
    latest_allowed = created + timedelta(hours=max_hours)
    deadline = created + timedelta(hours=default_hours)
    asked = parse_time(param) if param is not None else None
    if asked is not None:
        # An unreadable value falls back to the default: fail towards teardown.
        deadline = min(asked, latest_allowed)
    out["deadline"] = deadline

    remaining = (deadline - now).total_seconds() / 60
    if remaining > 0:
        out["state"] = "waiting"
        if WARN_TO_MIN < remaining <= WARN_FROM_MIN:
            out["notify"] = (
                "IDP: AWS teardown in about %d minutes" % round(remaining),
                "The session's stacks (%s) will be deleted at %s UTC.\n"
                "To keep working: make aws-extend HOURS=1 (the limit is %s UTC).\n"
                "To finish now: make aws-down" % (", ".join(sorted(stacks)), deadline.strftime("%H:%M"), latest_allowed.strftime("%Y-%m-%d %H:%M")),
            )
        return out

    out["state"] = "tearing_down"
    # Group by group. Every stack still present is (re)asked to delete,
    # including DELETE_FAILED ones: the cause may have been removed since.
    # Later groups wait while an earlier group is still being deleted. A
    # group that has only FAILED stacks left does not hold the rest back:
    # a stuck DNS stack must not keep the NAT gateway alive.
    for group in groups:
        present = [n for n in group if n in stacks]
        out["delete"] += [n for n in present if stacks[n]["status"] != IN_PROGRESS]
        if any(stacks[n]["status"] != FAILED for n in present):
            break
    # Stacks outside every group are never touched.

    statuses = {s["status"] for s in stacks.values()}
    # "fresh" = this run starts deleting something for the first time.
    fresh = any(stacks[n]["status"] != FAILED for n in out["delete"])
    overdue = (now - deadline).total_seconds() / 60
    listing = "\n".join("  %s: %s" % (n, stacks[n]["status"]) for n in sorted(stacks))
    if param is None or fresh:
        # Writing the deadline marks "a teardown happened", so the run that
        # finds no stacks can say so. It also makes the first email unique.
        out["set_param"] = deadline.isoformat()
    if fresh:
        out["notify"] = (
            "IDP: deadline passed, deleting the AWS session",
            "Nobody ran `make aws-down` by %s UTC, so the stacks are being deleted:\n%s\n\n"
            "This stops the cluster, Fargate and NAT. It does NOT remove what the cluster created "
            "(load balancer, buckets, DNS records). Run `make aws-down` to finish and audit." % (deadline.strftime("%Y-%m-%d %H:%M"), listing),
        )
    elif FAILED in statuses and overdue % STUCK_REMINDER_MIN < 15:
        out["notify"] = (
            "IDP: AWS teardown is STUCK, something may still be billing",
            "These stacks could not be deleted:\n%s\n\n"
            "Usual cause: a load balancer or DNS record the cluster created (about $0.04/h). "
            "Run `make aws-down`; it removes those first and then audits." % listing,
        )
    return out


def read_stacks(cfn, names):
    """{name: {status, created}} for the named stacks that exist."""
    found = {}
    for name in names:
        try:
            s = cfn.describe_stacks(StackName=name)["Stacks"][0]
        except Exception as e:  # botocore's ClientError; no import needed
            if "does not exist" in str(e):
                continue
            raise  # could not look: fail the run, the next one retries
        found[name] = {"status": s["StackStatus"], "created": s["CreationTime"]}
    return found


def read_param(ssm, name):
    try:
        return ssm.get_parameter(Name=name)["Parameter"]["Value"]
    except Exception as e:
        if "ParameterNotFound" in str(e):
            return None
        raise


def run(now, cfn, ssm, sns, cfg):
    """One run: read, decide, act. Returns the decision (for logs/tests)."""
    groups = cfg["groups"]
    stacks = read_stacks(cfn, [n for g in groups for n in g])
    param = read_param(ssm, cfg["param"])
    d = decide(now, stacks, groups, param, cfg["default_hours"], cfg["max_hours"])

    for name in d["delete"]:
        cfn.delete_stack(StackName=name)
    if d["set_param"] is not None:
        ssm.put_parameter(Name=cfg["param"], Value=d["set_param"], Type="String", Overwrite=True)
    if d["clear_param"]:
        ssm.delete_parameter(Name=cfg["param"])
    if d["notify"] is not None:
        sns.publish(TopicArn=cfg["topic"], Subject=d["notify"][0][:100], Message=d["notify"][1])
    return d


def handler(event, context):
    import boto3  # in the Lambda runtime; not needed by the tests

    cfg = {
        "groups": [g.split(",") for g in os.environ["STACK_GROUPS"].split(";")],
        "param": os.environ["DEADLINE_PARAM"],
        "topic": os.environ["TOPIC_ARN"],
        "default_hours": float(os.environ["DEFAULT_HOURS"]),
        "max_hours": float(os.environ["MAX_HOURS"]),
    }
    d = run(datetime.now(timezone.utc), boto3.client("cloudformation"), boto3.client("ssm"), boto3.client("sns"), cfg)
    summary = {"state": d["state"], "deadline": d["deadline"].isoformat() if d["deadline"] else None, "delete": d["delete"], "notified": bool(d["notify"])}
    print(json.dumps(summary))
    return summary
