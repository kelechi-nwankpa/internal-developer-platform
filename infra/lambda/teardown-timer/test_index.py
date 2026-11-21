"""Tests for the teardown timer. No AWS, no boto3.

Run: make timer-test

Part 1 tests decide(), the pure decision. Part 2 runs whole 15-minute
ticks against fake AWS clients and follows a forgotten session from
"waiting" to "all gone".
"""

import unittest
from datetime import datetime, timedelta, timezone

import index

T0 = datetime(2026, 12, 1, 10, 0, tzinfo=timezone.utc)  # stacks created
GROUPS = [["ClusterStack", "RegistryStack", "DnsStack", "IamStack"], ["VpcStack", "KmsStack"]]
ALL = [n for g in GROUPS for n in g]


def stacks(status="CREATE_COMPLETE", names=ALL, **override):
    out = {n: {"status": status, "created": T0} for n in names}
    for n, st in override.items():
        out[n]["status"] = st
    return out


def decide(now, st, param=None):
    return index.decide(now, st, GROUPS, param, default_hours=4, max_hours=12)


def at(hours=0, minutes=0):
    return T0 + timedelta(hours=hours, minutes=minutes)


class Deadline(unittest.TestCase):
    def test_no_stacks_does_nothing(self):
        d = decide(at(99), {})
        self.assertEqual((d["state"], d["delete"], d["notify"], d["clear_param"]), ("idle", [], None, False))

    def test_default_deadline_is_four_hours_after_creation_with_no_arming(self):
        self.assertEqual(decide(at(1), stacks())["deadline"], at(4))

    def test_before_the_deadline_nothing_is_deleted(self):
        d = decide(at(3, 59), stacks())
        self.assertEqual((d["state"], d["delete"]), ("waiting", []))

    def test_at_the_deadline_deletion_starts(self):
        self.assertEqual(decide(at(4), stacks())["state"], "tearing_down")

    def test_oldest_stack_sets_the_clock(self):
        st = stacks()
        st["VpcStack"]["created"] = T0 - timedelta(hours=2)
        self.assertEqual(decide(at(1), st)["deadline"], at(2))

    def test_extension_moves_the_deadline(self):
        d = decide(at(5), stacks(), param=at(6).isoformat())
        self.assertEqual((d["state"], d["deadline"]), ("waiting", at(6)))

    def test_extension_is_capped_so_a_typo_cannot_disable_the_timer(self):
        d = decide(at(5), stacks(), param=at(500).isoformat())
        self.assertEqual(d["deadline"], at(12))
        self.assertEqual(decide(at(12), stacks(), param=at(500).isoformat())["state"], "tearing_down")

    def test_unreadable_extension_falls_back_to_the_default(self):
        d = decide(at(4), stacks(), param="tomorrow-ish")
        self.assertEqual((d["state"], d["deadline"]), ("tearing_down", at(4)))

    def test_extension_can_also_bring_the_deadline_forward(self):
        self.assertEqual(decide(at(1), stacks(), param=at(1).isoformat())["state"], "tearing_down")

    def test_z_suffix_and_naive_times_are_read_as_utc(self):
        self.assertEqual(index.parse_time("2026-12-01T16:00:00Z"), at(6))
        self.assertEqual(index.parse_time("2026-12-01T16:00:00"), at(6))
        self.assertIsNone(index.parse_time(""))


class Warning(unittest.TestCase):
    def test_warns_once_in_the_30_to_15_minute_window(self):
        notified = [m for m in range(60, 0, -15) if decide(at(4) - timedelta(minutes=m), stacks())["notify"]]
        self.assertEqual(notified, [30])

    def test_warning_names_the_escape_hatch(self):
        subject, body = decide(at(3, 35), stacks())["notify"]
        self.assertIn("25 minutes", subject)
        self.assertIn("make aws-extend", body)
        self.assertIn("make aws-down", body)

    def test_no_warning_far_from_the_deadline(self):
        self.assertIsNone(decide(at(1), stacks())["notify"])


class Order(unittest.TestCase):
    def test_first_run_deletes_only_the_first_group(self):
        d = decide(at(4), stacks())
        self.assertEqual(d["delete"], GROUPS[0])

    def test_second_group_waits_while_the_first_is_in_progress(self):
        d = decide(at(4, 15), stacks(ClusterStack=index.IN_PROGRESS, RegistryStack=index.IN_PROGRESS, DnsStack=index.IN_PROGRESS, IamStack=index.IN_PROGRESS))
        self.assertEqual(d["delete"], [])
        self.assertIsNone(d["notify"])

    def test_second_group_goes_once_the_first_is_gone(self):
        d = decide(at(4, 30), stacks(names=GROUPS[1]))
        self.assertEqual(d["delete"], GROUPS[1])

    def test_a_stuck_stack_is_retried_and_does_not_hold_back_the_nat_gateway(self):
        st = stacks(names=["DnsStack", "VpcStack", "KmsStack"], DnsStack=index.FAILED)
        self.assertEqual(decide(at(4, 30), st)["delete"], ["DnsStack", "VpcStack", "KmsStack"])

    def test_in_progress_stacks_are_not_asked_again(self):
        st = stacks(names=["ClusterStack", "DnsStack"], ClusterStack=index.IN_PROGRESS, DnsStack=index.FAILED)
        self.assertEqual(decide(at(4, 30), st)["delete"], ["DnsStack"])

    def test_stacks_outside_the_groups_are_never_deleted(self):
        st = stacks()
        st["CostStack"] = {"status": "CREATE_COMPLETE", "created": T0}
        seen = set()
        for m in range(0, 180, 15):
            seen.update(decide(at(4, m), st)["delete"])
        self.assertNotIn("CostStack", seen)


class Emails(unittest.TestCase):
    def test_start_email_says_what_is_left_behind(self):
        subject, body = decide(at(4), stacks())["notify"]
        self.assertIn("deleting", subject)
        self.assertIn("make aws-down", body)
        self.assertIn("does NOT remove", body)

    def test_stuck_email_once_a_day_not_every_tick(self):
        st = stacks(names=["VpcStack"], VpcStack=index.FAILED)
        sent = [m for m in range(0, 48 * 60, 15) if decide(at(4, m), st, param=at(4).isoformat())["notify"]]
        self.assertEqual(sent, [0, 24 * 60])
        self.assertIn("STUCK", decide(at(4), st, param=at(4).isoformat())["notify"][0])

    def test_all_gone_email_and_parameter_cleanup(self):
        d = decide(at(5), {}, param=at(4).isoformat())
        self.assertTrue(d["clear_param"])
        self.assertIn("gone", d["notify"][0])


# ── Part 2: whole ticks against fake AWS ────────────────────────────────
class NotFound(Exception):
    pass


class FakeAws:
    """CloudFormation, SSM and SNS in one object. A deleted stack goes
    IN_PROGRESS and disappears one tick later, unless it is in `sticky`
    (then it ends DELETE_FAILED, like a VPC with a load balancer in it)."""

    def __init__(self, names, sticky=()):
        self.stacks = {n: "CREATE_COMPLETE" for n in names}
        self.sticky = set(sticky)
        self.param = None
        self.calls = []
        self.emails = []
        self.broken = False

    def tick(self):  # time passes between runs
        for n, st in list(self.stacks.items()):
            if st == index.IN_PROGRESS:
                if n in self.sticky:
                    self.stacks[n] = index.FAILED
                else:
                    del self.stacks[n]

    def describe_stacks(self, StackName):
        if self.broken:
            raise RuntimeError("AccessDenied")
        if StackName not in self.stacks:
            raise NotFound("Stack with id %s does not exist" % StackName)
        return {"Stacks": [{"StackStatus": self.stacks[StackName], "CreationTime": T0}]}

    def delete_stack(self, StackName):
        self.calls.append("delete " + StackName)
        self.stacks[StackName] = index.IN_PROGRESS

    def get_parameter(self, Name):
        if self.param is None:
            raise NotFound("ParameterNotFound")
        return {"Parameter": {"Value": self.param}}

    def put_parameter(self, Name, Value, Type, Overwrite):
        self.param = Value

    def delete_parameter(self, Name):
        self.param = None

    def publish(self, TopicArn, Subject, Message):
        self.emails.append(Subject)


CFG = {"groups": GROUPS, "param": "/idp/teardown/deadline", "topic": "arn:topic", "default_hours": 4, "max_hours": 12}


def run_session(aws, hours, start_minute=0):
    """Tick every 15 minutes from T0+start for `hours`; returns states seen."""
    states = []
    for m in range(start_minute, int(hours * 60) + 1, 15):
        states.append(index.run(at(0, m), aws, aws, aws, CFG)["state"])
        aws.tick()
    return states


class WholeSession(unittest.TestCase):
    def test_forgotten_session_is_deleted_in_order_and_reported(self):
        aws = FakeAws(ALL)
        states = run_session(aws, hours=6)
        self.assertEqual(aws.stacks, {})
        self.assertEqual(aws.calls, ["delete " + n for n in ALL])
        self.assertEqual(states.count("waiting"), 16)  # 0:00 .. 3:45
        self.assertEqual(
            aws.emails,
            [
                "IDP: AWS teardown in about 30 minutes",
                "IDP: deadline passed, deleting the AWS session",  # group 1
                "IDP: deadline passed, deleting the AWS session",  # group 2
                "IDP: all session stacks are gone",
            ],
        )
        self.assertIsNone(aws.param)

    def test_nothing_is_deleted_before_the_deadline(self):
        aws = FakeAws(ALL)
        run_session(aws, hours=3.75)
        self.assertEqual(aws.calls, [])
        self.assertEqual(len(aws.stacks), 6)

    def test_extension_delays_and_then_the_teardown_still_happens(self):
        aws = FakeAws(ALL)
        aws.param = at(6).isoformat()
        run_session(aws, hours=5.75)
        self.assertEqual(aws.calls, [])
        run_session(aws, hours=8, start_minute=6 * 60)
        self.assertEqual(aws.stacks, {})

    def test_stuck_vpc_is_retried_every_tick_without_an_email_storm(self):
        aws = FakeAws(ALL, sticky=["VpcStack"])
        run_session(aws, hours=8)
        self.assertEqual(aws.stacks, {"VpcStack": index.FAILED})
        self.assertGreater(aws.calls.count("delete VpcStack"), 10)
        self.assertEqual(aws.calls.count("delete KmsStack"), 1)
        self.assertLessEqual(len(aws.emails), 4)

    def test_stuck_stack_recovers_when_the_cause_is_removed(self):
        aws = FakeAws(ALL, sticky=["VpcStack"])
        run_session(aws, hours=6)
        aws.sticky.clear()  # someone ran `make aws-down`: the load balancer is gone
        run_session(aws, hours=7, start_minute=6 * 60 + 15)
        self.assertEqual(aws.stacks, {})
        self.assertEqual(aws.emails[-1], "IDP: all session stacks are gone")

    def test_manual_teardown_before_the_deadline_means_the_timer_never_acts(self):
        aws = FakeAws(ALL)
        run_session(aws, hours=1)
        aws.stacks.clear()  # `make aws-down`
        run_session(aws, hours=8, start_minute=75)
        self.assertEqual((aws.calls, aws.emails), ([], []))

    def test_a_failed_lookup_fails_the_run_instead_of_reading_as_no_stacks(self):
        aws = FakeAws(ALL)
        aws.broken = True
        with self.assertRaises(RuntimeError):
            index.run(at(5), aws, aws, aws, CFG)
        self.assertEqual(aws.calls, [])


if __name__ == "__main__":
    unittest.main()
