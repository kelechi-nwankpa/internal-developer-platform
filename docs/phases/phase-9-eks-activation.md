# Phase 9 — EKS activation + cost, DR, ops

**Status:** 🚧 In progress. Everything that costs $0 is built and tested on
kind first. The live EKS session waits until the budget cap is raised
(owner's decision, see `docs/COST.md`).

## Business problem

The platform has only ever run on a laptop. Three things stand between it
and a credible "runs in the cloud" claim:

1. **Cost is not under control.** Phase 1 cost $27.17 against a $5–15 projection, and nothing stopped it.
2. **There is no front door.** Every service is reached with `kubectl port-forward`. A developer cannot open a URL.
3. **Operations are untested.** Alerts reach nobody, there are no recovery runbooks, and no restore has ever been rehearsed.

## Target users

- **Service developers:** want a working HTTPS URL for a new service with
  no certificate, DNS or load-balancer work.
- **The platform owner:** wants to run an EKS session knowing the bill in
  advance, and to be told when something breaks.

## Business value

- A new service is reachable over HTTPS as part of the golden path.
- An AWS session cannot start if it would breach the cap or land on a
  surcharged Kubernetes version.
- Failures become signals to a person instead of surprises found later.

## Architecture

```text
Mac ──80/443──▶ kind node ──hostPort──▶ Envoy proxy (ns gateway)
                                            │  TLS: *.idp.seniormankelz.dev
                                            ▼
                              HTTPRoute (team namespace) ──▶ Service ──▶ Pod
```

On EKS only the first hop changes: an NLB replaces the kind host ports.

## Components

| Component | Where | Role |
|---|---|---|
| Envoy Gateway 1.9.4 | `platform/argocd/apps/envoy-gateway.yaml` | Gateway API controller + CRDs |
| Shared edge | `platform/gateway/` | Namespace, GatewayClass, proxy settings, Gateway, wildcard certificate, HTTP redirect |
| Preflight guard | `scripts/aws-preflight.sh`, `make aws-up` | Refuses costly deploys |
| Cost record | `docs/COST.md` | Actual spend and session estimate |

## Data flow (a request)

1. The client resolves `<svc>.idp.seniormankelz.dev` (on kind: `--resolve …:443:127.0.0.1`).
2. Envoy terminates TLS with the platform wildcard certificate.
3. Envoy matches the hostname to the team's `HTTPRoute` and forwards to the Service over plain HTTP inside the cluster.
4. A plain-HTTP request never reaches a service: it gets a 301 to HTTPS.

## Security

- **Deny-by-default attachment.** Only namespaces labelled
  `edge.idp.seniormankelz.dev/allow-routes: "true"` may attach routes, and
  only to the HTTPS listener. The label is set in the platform repo.
- **One wildcard key**, kept in the `gateway` namespace, rotated at every
  renewal, 90-day lifetime.
- **One Pod Security exception:** `gateway` enforces `privileged` on kind
  for hostPort 80/443. Audit and warn stay at `baseline`. A Kyverno
  policy (`restrict-gateway-namespace`, Enforce) narrows that back to
  baseline plus host ports 80 and 443 (section 6).

## Operations

- ArgoCD marks an app `Degraded` when the Gateway refuses its route, so
  the Phase 8 app-health alert covers the edge.
- Critical alerts are emailed (section 3). Runbooks: `docs/runbooks/`
  (disk full, repo restore, kind recovery). One real restore carried
  out (section 4).

## What shipped so far

### 1. Cost facts and guardrails ($0.01 spent on Cost Explorer)

- `docs/COST.md`: actual spend **$27.19**; the largest line was the EKS
  extended-support surcharge ($11.65). Session estimate: about $2.30 for
  3 hours, about $12 if forgotten for 24 hours (`7e7ce4b`).
- EKS pinned to Kubernetes 1.36, in standard support and matching kind
  (`955f9f2`).
- `make aws-up` runs a preflight that fails closed on: tools,
  credentials, Kubernetes support status, and spend + estimate vs cap.
  17 unit tests. It currently refuses, by design (`e51b914`).

### 2. Edge routing through the Gateway API (ADR-0033)

| Step | Commit | Result |
|---|---|---|
| Controller + CRDs | `5350892` | Envoy Gateway Synced/Healthy |
| Namespace, GatewayClass, kind proxy settings | `0d0c713` | GatewayClass `Accepted` |
| Shared Gateway, HTTP listener | `4b09631`, `9af3ebe` | `curl` to port 80 reaches Envoy |
| Wildcard certificate, HTTPS listener, redirect | `ab48631` | HTTPS served, HTTP returns 301 |
| First service attached | `7fef4f6`, platform-hello `048b74c` | `/hello` returns 200 over HTTPS |
| Template, external-dns, ADR | `0987ec7`, `9cf79f1`, `2e5deee` | New services get a route by default |

**End-to-end check:**

```bash
curl -k --resolve platform-hello.idp.seniormankelz.dev:443:127.0.0.1 \
  https://platform-hello.idp.seniormankelz.dev/hello
```

Returns 200 with the S3 write and read-back. Before the namespace label
was granted, the same route was refused (`NotAllowedByListeners`).

### 3. Alerts that reach a person

**Decisions:** email through Gmail SMTP ($0, no new account); only
`severity=critical` is emailed, warnings stay in the Alertmanager UI; the
SMTP password and the email address live in Vault, never in Git.

| Step | Commit | Result |
|---|---|---|
| Remove 9 permanent false alarms (control-plane targets kubeadm binds to 127.0.0.1) | `0d7511a` | Includes a critical `etcdInsufficientMembers` that fired while etcd was healthy |
| Alertmanager config rendered from Vault by External Secrets | `a61d4e9`, `e9570b7`, `55f8d7d`, `25e4b91` | Test alert emailed and confirmed in the inbox |
| Disk and certificate alerts, `make rules-test` | `4473358` | 5 rules |
| Postgres metrics exporter (upstream image, digest-pinned) + NetworkPolicy | `ab9c24f`, `19f2818`, `5a9c6a0` | `pg_up` and per-database connection counts |
| Backstage database alerts | `3e36118` | 2 rules |

**New alerts** (`platform/monitoring/platform-health-rules.yaml`):

| Alert | Fires when | Severity |
|---|---|---|
| `NodeDiskUsageHigh` | Disk above 80% for 15m | warning |
| `NodeDiskUsageCritical` | Disk above 90% for 5m | critical |
| `CertificateExpiringSoon` | Under 14 days left (renewal is due at 30) | critical |
| `CertificateNotReady` | Not Ready for 30m | critical |
| `CertManagerMetricsAbsent` | No certificate metrics for 30m | critical |
| `BackstageNotUsingPostgres` | Backstage and Postgres up, zero connections to any plugin database for 15m | critical |
| `BackstagePostgresDown` | `pg_up` is 0 or absent for 15m | critical |

**Tests:** 13 promtool cases, each alert in both directions. Eleven
deliberate mutations of the rules (wrong thresholds, dropped guards,
inverted conditions) were all caught. `make rules-test` fails if a test
file is not registered.

**Faults found while building it:**

| # | Fault | Fix |
|---|---|---|
| P9-6 | **Prometheus write-ahead log corrupt** since the disk-full event; 152 failed compactions, memory at 733 MB and growing. | Moved `wal` and `chunks_head` aside on the node and restarted. Lost about 80 minutes of metrics; memory fell to 181 MB. |
| P9-7 | **ExternalSecret showed as drift** because the API server adds default fields. | Wrote the defaults into Git. |
| P9-8 | **Exporter logged a permission error on every scrape** (WAL collector). The chart cannot pass `--no-collector.wal`. | One-off `GRANT pg_monitor TO backstage`, recorded in `backstage.yaml`. Not in Git: re-run if the volume is recreated. |
| P9-9 | **Postgres pod failed the platform's own Kyverno policies** (no `part-of` label, no limits). | `primary.podLabels` and `primary.resources`. |

**Known gaps:**

- Nothing watches the watcher. If Prometheus, Alertmanager or the laptop
  is down, no email is sent. An external dead-man's switch on the
  `Watchdog` alert is the fix; it suits EKS, not a laptop that sleeps.
- A restart of Postgres makes `BackstageNotUsingPostgres` go pending for a
  minute or two. The 15-minute `for` absorbs it; it never fired.
- The Docker VM is short of memory (77% used, heavy paging on `vda`). The
  warnings `NodeMemoryMajorPagesFaults` and `NodeClockNotSynchronising`
  are true and are not emailed.

### 4. Runbooks and a real restore

- New runbooks: [disk-full.md](../runbooks/disk-full.md),
  [github-repo-restore.md](../runbooks/github-repo-restore.md), and
  Failure Mode 7 in [kind-recovery.md](../runbooks/kind-recovery.md).
- The rehearsed restore turned out to be a real one:

| # | Fault | Fix |
|---|---|---|
| P9-10 | **Vault's storage claim had been `Terminating` since 2026-10-29.** A `delete pvc` during the Phase 5 Vault reset raced with ArgoCD self-heal and landed on the recreated claim. Only the running pod kept it; deleting the pod would have wiped every secret. Nothing reported it. | Volume set to `Retain`; procedure rehearsed on a throwaway StatefulSet; then Vault stopped, old claim released, the same data directory re-attached through a static volume, Vault unsealed. 76 files, checksum identical before and after. No data copied. |
| P9-11 | **Vault refused every login after its pod was replaced** (403). The original setup stored a copy of the pod's own token as `token_reviewer_jwt`; the token died with the pod. | Config rewritten without it; Vault now uses its current token. Setup command in the runbook corrected. |

**What the rehearsal caught and missed.** It proved the data survives the
pending deletion and that pre-creating the claim avoids a start-up race.
It did not cover Vault's login config, so P9-11 only appeared during the
real run. Workloads were unaffected: their Kubernetes Secrets stayed in
place throughout.

**Still weak:** Vault's data is one copy on one disk. Two encrypted
copies sit in the node under `/var/local-path-provisioner/_backups/`;
neither survives losing the node. The static volume is cluster state, not
in Git, like every dynamically provisioned volume.

### 5. Backstage's Postgres passwords now come from Vault

Closes the follow-up left by P9-5. The stopgap (ArgoCD told to ignore the
chart-generated Secret) is gone.

- Vault `secret/backstage/postgres` is the source of truth. An
  ExternalSecret copies it into `backstage-postgresql-auth`; the chart is
  pointed at it with `postgresql.auth.existingSecret` and generates
  nothing. The old Secret was pruned.
- Done in two commits so each step could be checked alone: first the
  ExternalSecret (nothing reads it, nothing can break), then the switch,
  only after both values matched the live Secret by hash.
- Verified after: Backstage, Postgres and the exporter all read the new
  Secret; both database logins work; 15 plugin databases in use; catalog
  intact; `pg_up` 1; 29 of 29 Applications Synced/Healthy.

| # | Fault | Fix |
|---|---|---|
| P9-12 | **Backstage does not recover if it starts while Postgres is restarting.** The switch rolled both at once. The new Backstage pod hit "database system is shutting down", failed plugin start-up and stayed at readiness 503 for good. No outage: the old pod kept serving because the new one never became ready. | Deleted the stuck pod; its replacement started clean. Then fixed (`c8a50bc`): the chart's start-up probe checked `/liveness`, which answers 200 before any plugin has reached the database. It now checks `/readiness`, so the kubelet restarts a container whose start-up never finished (budget 120s). Proved by restarting Postgres and Backstage together: the new pod stuck, was restarted once at ~125s and was ready at 138s; the old pod served throughout. |

**What I got wrong.** I pushed the ExternalSecret before the values were
in Vault, on an ambiguous "go on". It failed with "Secret does not
exist" and was reverted (`5488e5e`) before anything consumed it.

**Rotation is two steps, in order:** change the password in Postgres,
then write the same value to Vault and restart Backstage. Postgres never
re-reads the Secret.

### 6. The `gateway` namespace exception, narrowed

Pod Security has no per-field exemption, so allowing two host ports meant
setting the namespace to `privileged`, which checks nothing. A Kyverno
policy, `restrict-gateway-namespace` (Enforce), gives the rest back:

- **Rule 1:** every `baseline` check, with the Host Ports control switched
  off.
- **Rule 2:** a hostPort must be 80 or 443 (containers, init containers,
  ephemeral containers).

Verified three ways: offline against 8 example pods (`make policy-test`);
offline against the live proxy pod and Deployment (both pass); and by
server dry-run against the cluster, where the five forbidden pods were
each denied by this policy and the real proxy was still admitted.

| # | Fault | Fix |
|---|---|---|
| P9-13 | **`kyverno test` reported "10 tests passed" for a broken policy.** A copy edited to allow port 8080, and one pointed at the wrong namespace, both passed. The CLI prints "Want fail, got pass" and still counts the row as passed; a rule that matched nothing is "Excluded" and also passes. Same on CLI v1.14.4 to v1.16.1. Found only because I broke the policy on purpose to check the tests. | `scripts/policy-test.sh` runs `kyverno apply` and compares its report line for line with an expected table. All four deliberate breakages now fail it. |

**Lesson.** A test that has never been seen to fail proves nothing. Break
the thing under test before trusting a green result.

### 7. Two owner decisions, carried out

- **No wildcard DNS record** (`eac2ff7`). The hostname-less redirect route
  made external-dns want `*.idp.seniormankelz.dev`. The route is now
  marked as not managed by external-dns. Checked: external-dns went from
  two wanted records to one (`platform-hello`), and the 301 redirect
  still works. Deny by default: only names with a real service resolve.
- **Vault backup off the node** (`make vault-backup`). Vault's data was
  one copy inside the kind node. The script copies it to
  `~/idp-backups/vault` while Vault runs, and proves consistency by
  fingerprinting the folder before and after the copy. It refuses to
  write inside a Git repository. Restore steps: Failure Mode 8 in
  [kind-recovery.md](../runbooks/kind-recovery.md).
- **Restore check:** a throwaway Vault started on the backup and
  reported initialised, sealed, 5 shares, threshold 3. Unsealing a
  restored copy is not tested yet; it needs the owner's keys.

### 8. S3 bucket access on AWS through IRSA (offline, $0)

The S3 Composition already existed but only created the bucket: no IAM,
no connection details, never rendered once. A service on EKS would have
had a bucket it could not reach. It now also creates an IAM policy (that
bucket only), an IAM role (assumable by one ServiceAccount through the
cluster's OIDC provider) and the attachment, and publishes
`BUCKET_NAME`, `AWS_REGION` and `AWS_ROLE_ARN`. Decision and rejected
options: [ADR-0034](../adr/0034-bucket-access-on-aws-via-irsa.md).

Also fixed on the way: bucket and IAM names are capped to fit AWS limits;
a missing UID is refused where a random name used to be invented; every
AWS resource is tagged `Project=idp`; the kind default is unchanged.

Tested with `make composition-test` (8 cases): exact output, the
provider's real schemas, and IAM rules (one named bucket, one
ServiceAccount, `StringEquals` only). Ten deliberate breakages, all
caught.

| # | Fault | Fix |
|---|---|---|
| P9-14 | **`crossplane render` uses a floating `stable` engine image, which resolved to a release candidate (v2.5.0-rc.1).** The same test could give different results next month. | The script pins the engine to v2.4.1. |
| P9-15 | **The first version of the test missed a loosened Secret condition.** The Secret and `status.roleArn` each had their own copy of the condition, and `render` shows only the status. | Both now use one shared condition. |

Not proven yet, by design: that AWS accepts these resources (needs the
EKS session), and the Secret's key names (render does not print
connection details; the v1.20 CLI that might was not installed).
**The service side.** The template and platform-hello now mount a
ServiceAccount token for `sts.amazonaws.com` and set
`AWS_WEB_IDENTITY_TOKEN_FILE`. Checked two ways:

- With the real AWS SDK, offline: key + token file resolves to the key
  (kind is unchanged); role + token file with no key goes to STS.
- On kind, in the running pod: the token's audience is
  `sts.amazonaws.com` and its subject is
  `system:serviceaccount:platform-hello:platform-hello`, exactly the
  value the role's trust policy pins. `/hello` through the edge: 200.

Left for the EKS session: create the `idp-cluster` EnvironmentConfig,
give the Crossplane provider IAM rights limited to `role/idp-*` and
`policy/idp-*`, switch the XRD's default Composition to S3.

### 9. Post-teardown audit (`make aws-audit`)

"cdk destroy finished" is not proof that billing stopped: CloudFormation
only knows what it created. The audit lists resources directly. Anything
that bills is a failure (exit 1); free leftovers are warnings; a check
that cannot run is a failure; missing budget alarms are a failure.
Read-only, $0. Unit-tested without AWS (`make audit-test`, 29 cases, ten
deliberate breakages all caught).

First real run, 2026-11-21: nothing billing, budget alarms armed, and
one leftover from Phase 1.

| # | Fault | Fix |
|---|---|---|
| P9-16 | **Phase 1's teardown left the log group `/aws/eks/idp/cluster`** (134 MB, no expiry, about $0.004/month). CloudFormation did not create it (EKS did), so `cdk destroy` never removed it. | Found by the audit. Deleting it is the owner's call; the teardown order (next) removes it in future. |
| P9-17 | **The first audit reported seven S3 buckets from other projects.** The account is shared, and S3 cannot be listed by tag. | Each bucket's `Project` tag is read; only `Project=idp` buckets count. |

### 10. Teardown in an order that works (`make aws-down`)

The old `aws-down` ran `cdk destroy` and printed "complete". That
removes only what CloudFormation created. A session also leaves a load
balancer, buckets, IAM roles and DNS records made by the cluster's
controllers; they keep billing, and a VPC or hosted zone that still
contains them cannot be deleted.

Order: (1) destroy ClusterStack, so no controller can recreate anything;
(2) sweep the leftovers straight from AWS, repeating until none remain;
(3) destroy the other stacks, with one sweep-and-retry if that fails;
(4) run the audit, which decides the exit code.

Two decisions worth remembering:

- **No kubectl in teardown.** "Delete the claims and let Crossplane
  clean up" is the textbook order, but if kubectl pointed at kind it
  would wipe the local platform, and it cannot work on a broken cluster,
  which is when teardown is hardest.
- **The account is shared, so every delete must prove ownership.**
  Network resources must be in a VPC tagged `Project=idp`; DNS records in
  the project zone; buckets, roles and policies tagged `Project=idp`,
  re-checked just before the delete; log groups under the cluster's
  prefix. `make aws-down-plan` shows the list and changes nothing.

Tested with `make down-test` (28 cases): the planners against mixed
"ours and another project's" data, refusals, and the whole teardown
against a fake AWS that records every changing call; the record must
match exactly, in order. Sixteen deliberate breakages, all caught.
`make aws-down-plan` on the real account lists one item: the Phase 1
log group (P9-16).

Not proven: a teardown of a real session. In particular the names and
tags of what the load-balancer controller creates on EKS are assumed
from documentation, so the first real teardown must be watched, and the
audit is the backstop.

### 11. Teardown timer (deployed 2026-11-21)

The one guard that needs nobody at the keyboard. A rule runs a small
Lambda every 15 minutes. With no workload stacks it does nothing. Once
the oldest stack is 4 hours old it asks CloudFormation to delete the
stacks, group by group, and keeps asking until they are gone. It emails
about 30 minutes before, when it acts, once a day if stuck, and when
everything is gone.

Design choices:

- **No arming step.** The clock is the stack's own creation time, so a
  hand-run `cdk deploy` is covered. A step that can be skipped is the
  failure this exists to remove.
- **`make aws-extend HOURS=n`** writes a later deadline, capped at 12
  hours after creation so a typo cannot switch the timer off. There is
  no off switch.
- **Narrow rights.** It may describe and delete six named stacks, use
  one parameter, publish to its own topic and write its own logs. It
  holds no direct right to delete a cluster or a VPC.
- **Lives in CostStack**, which is never torn down and whose absence
  already fails the audit.
- **Rejected:** running the full `make aws-down` in CodeBuild at the
  deadline. Complete, but a standing role with broad delete rights that
  runs whatever is on the main branch of a public repository.

Known limit, with its price: it does not remove what the cluster's
controllers created. Deleting the stacks stops the cluster, Fargate and
NAT (about 90% of the hourly cost); a load balancer can leave the VPC
stack in DELETE_FAILED at about $0.04/h ($0.90/day) until `make aws-down`
is run. The email says so.

Tested: `make timer-test` (29 cases: the decision rules, then whole
sessions ticked every 15 minutes against fake AWS; eleven deliberate
breakages all caught) and 12 CDK tests on the permissions.

| # | Fault | Fix |
|---|---|---|
| P9-18 | **First version: one stuck stack held back all the others.** A DNS stack that could not be deleted would have kept the VPC stack, and so the NAT gateway, alive. Found in review before any test existed. | A group with only stuck stacks left no longer blocks the next group; stuck stacks are retried every run. |

**Switched on in code (owner approved 2026-11-21).** The right "delete
stack X" must end in a wildcard, because a stack's unique id changes on
every deploy, and cdk-nag requires a written exception per wildcard.
Six exceptions were added, one per stack name, each matching only that
stack's ARN. Checked that they are narrow: `stack/*`, another stack's
name, `stack/ClusterStack*` and `parameter/*` all still fail the linter.
`infra/bin/idp.ts` now passes the stack groups; `cdk synth --all` is
clean; 73 CDK tests pass.

**Deployed 2026-11-21 (owner approved), $0.** CostStack went to
`UPDATE_COMPLETE` with nine new resources. Checked afterwards: the four
budget alarms are unchanged; the function is `Active` on `python3.15`;
the rule is `rate(15 minutes)`, enabled; one real invocation returned
`idle`, which also shows the "stack does not exist" and "parameter not
found" answers from real AWS are read correctly.

| # | Fault | Fix |
|---|---|---|
| P9-19 | **The deploy preview showed the four budget alarms "may be replaced".** The newer aws-cdk-lib can tag a Budget, so the app-level `Project`/`ManagedBy` tags would have been added to them. A change meant to add a timer would have touched the guardrail itself. Found only because the change was previewed before deploying. | Budgets are excluded from tagging (`a7ad7e5`); the update became nine additions and no changes. The audit now also accepts a rolled-back update as "armed". |

Still open: the email subscription is `PendingConfirmation` until the
owner clicks the link AWS sent. Until then the timer still deletes on
time; it just cannot email. Not proven until a real session: that
CloudFormation accepts a delete from this role without `iam:PassRole`.

### 12. Leftover removed; AWS is clean

The Phase 1 log group (P9-16) was deleted with the owner's approval.
`make aws-audit`: "Clean: nothing billing, nothing left over", budget
alarms armed. `make aws-down-plan`: nothing.

### 13. A brand-new service from the template (offline)

Rendered the template for a pretend service `demo-orders` and checked,
without creating anything:

- every manifest passes the cluster's admission checks (server dry-run,
  Kyverno included), and so does the generated ArgoCD Application;
- the generated service installs, builds and passes its 7 tests;
- the pieces line up: pod ServiceAccount = claim name = `demo-orders`
  (what the IAM role's trust policy will pin), the token is mounted for
  `sts.amazonaws.com` at the path `AWS_WEB_IDENTITY_TOKEN_FILE` names,
  the Deployment loads the Secret the claim writes, and the route
  attaches to `gateway/edge`.

Not covered: the Backstage "Create" click itself, the new GitHub
repository and its first CI run. That creates a real public repository,
so it is the owner's call.

## Incident 2026-11-21 — node restart exposed four latent faults

The Mac's Docker VM disk filled up; recovering it restarted the kind node.
Four older faults then surfaced.

| # | Fault | Since | Fix |
|---|---|---|---|
| P9-1 | **Docker VM disk full.** kind has no kubelet image garbage collection; cached images filled 32 GB. ArgoCD failed with "No space left on device". | Gradual | Pruned unused images in the node (`crictl rmi --prune`). No alert reached anyone. |
| P9-2 | **Vault sealed after restart**, so every ExternalSecret went stale. | By design (Phase 2) | Owner unsealed; ClusterSecretStore re-validated. Needs a runbook. |
| P9-3 | **Postgres had no NetworkPolicy ingress allow** under deny-default. Wave 2's check only covered a connection that was already open. | Phase 8 Wave 2 | `allow-ingress-postgresql` (`0780dcf`), verified with a new connection. |
| P9-4 | **Backstage ran on in-memory SQLite, not Postgres.** The chart set `POSTGRES_*` env vars but app-config had no `backend.database`, so Backstage fell back silently. Scaffolder history and sessions were lost on every restart while readiness stayed 200. | Phase 5 | `backend.database` with `client: pg` (`bb8ed9d`). Verified: 15 plugin databases, 29 entities, data survives a restart. |
| P9-5 | **ArgoCD rewrote the Postgres password Secret.** The bitnami chart generates a random password on each fresh render; hard-refreshing every Application forced fresh renders. | Caused during this incident | `ignoreDifferences` on the Secret + `RespectIgnoreDifferences` (`0780dcf`); owner re-aligned the database passwords to the Secret. |

### What I got wrong (kept honest)

- **Wrong diagnosis.** I reported "Backstage cannot log in to its
  database, so the catalog won't load". I inferred it from the mismatched
  Secret and never checked Backstage's own connections. Backstage was not
  using Postgres at all (P9-4). The catalog was loading the whole time.
- **I caused P9-5** by hard-refreshing all Applications at once.
- **Three broken command blocks** handed to the owner for the password
  fix: zsh does not word-split `$P`; the pod has `PGDATA`, not
  `POSTGRESQL_DATA_DIR`; `psql -c` does not substitute `:'var'`. Each
  failure left the database unchanged, but each cost a round trip.
- **ADR-0033 claimed kind needed recreating** for port mappings. It
  already mapped 80/443. Corrected in the ADR.

### Lessons

- "Synced/Healthy" and a 200 readiness probe say the process is up, not
  that it is using the right dependencies. Check the dependency itself.
- Test a NetworkPolicy with a **new** connection, from the real client.
- Never hard-refresh every ArgoCD Application; charts with random values
  re-roll them.
- Before diagnosing "X cannot reach Y", confirm X is trying to.

## Wave 1 close-out — everything that costs $0

**Status:** Wave 1 complete, 2026-11-21. Phase 9 stays open: the live
EKS session (Wave 2) waits for the owner to raise the budget cap.

### Summary

Phase 9 set out to run the platform on EKS. Planning found that Phase 1
had cost $27.17 of a $30 cap, so the phase was split: do everything that
costs nothing first, on kind and offline, and spend money only on a
session that is short, guarded and already rehearsed. Wave 1 delivered
the edge (Gateway API), alerts that reach a person, runbooks with a real
restore behind them, the EKS version of bucket access (IRSA), and four
layers of cost control: a preflight that refuses to deploy, a teardown
that works in order, an audit that checks AWS directly, and a timer that
needs nobody.

### What I got wrong along the way (kept honest)

- Diagnosed "Backstage is locked out of its database" when Backstage had
  never used that database (P9-4).
- Pushed a change on an ambiguous "go on" before the owner's step was
  done; reverted it.
- Three of my own first versions were wrong and were caught by breaking
  them on purpose or by review: the Kyverno test tool (P9-13), the
  Composition test (P9-15), the timer's ordering (P9-18).
- Told the owner the timer would run the full teardown from CodeBuild,
  then recommended the smaller design once the permissions it needed
  were clear.

### Business value delivered (Wave 1)

- A forgotten session now costs about $3 (4 hours), not $12 to $27.
- "Is anything still billing?" has a one-command, read-only answer.
- A service's bucket on AWS needs no stored key, and its permissions are
  tested before any money is spent.
- Services are reachable by HTTPS hostname through one shared edge.
- A critical alert reaches an inbox; recovery steps were exercised on a
  real failure, not written from imagination.

### Key concepts

Gateway API (GatewayClass, Gateway, HTTPRoute) · Pod Security levels and
why `privileged` checks nothing · startup vs liveness vs readiness
probes · IRSA: OIDC trust, `sub` and `aud` conditions, the SDK
credential chain · Crossplane function pipelines, required resources,
fail-closed Compositions · golden-file tests plus independent invariants
· mutation-testing a test harness · plan/execute separation for
destructive scripts · ownership proofs on a shared account · dead-man's
switch vs arm/disarm · scoped linter exceptions.

### Tech touched

Envoy Gateway, cert-manager, external-dns, Kyverno, Alertmanager,
Prometheus (promtool), Vault + External Secrets, Crossplane
(function-go-templating, provider-aws-s3/iam), AWS IAM/STS, AWS CDK
(Lambda, EventBridge, SNS, SSM), CloudFormation, bash + jq, Python.

### Interview talking points

- "My first cloud phase cost twice its estimate. I found out four months
  late, from Cost Explorer. So I built the controls in the order the
  failure happened: refuse to deploy an expensive version, tear down in
  an order that works, audit AWS directly, and a timer for when I'm not
  there."
- "`cdk destroy` succeeding is not evidence. CloudFormation only knows
  what it created; the cluster's controllers create load balancers,
  buckets and DNS records behind its back. My audit lists resources, it
  doesn't ask CloudFormation's opinion. Its first run found a log group
  Phase 1 had left behind."
- "The teardown uses no kubectl. The textbook order is 'delete the
  claims, let the controllers clean up', but that fails exactly when the
  cluster is broken, and pointed at the wrong context it deletes the
  wrong cluster's data."
- "I break my tests on purpose. `kyverno test` reported 10 passes for a
  policy I had deliberately broken. Three of my own harnesses had the
  same kind of hole. A test you have never seen fail is a guess."
- "For the timer I chose the design with fewer rights over the one that
  cleans up more: delete six named stacks, versus a standing role with
  broad delete rights on a shared account. The cost of that choice is
  known: about $0.04 an hour for a leftover load balancer."

### Recruiter Q&A

- **Why not just leave EKS running for the demo?** The control plane
  alone is $72 a month. The platform is cluster-agnostic; kind is the
  daily driver and EKS is a rehearsed, timed session.
- **How do you know the AWS parts work if you haven't run them?** I
  don't, fully, and the log says which parts: the IRSA role is rendered
  and schema-checked but AWS has not accepted it; the teardown and timer
  ran only against fakes. Each has a named first-run check.
- **What would you do differently?** Record actual spend the week after
  every session. Every later control exists because that one habit was
  missing.

### Loose ends

- Confirm the teardown timer's email subscription (link in the owner's
  inbox).
- Unseal a restored Vault backup once, on a throwaway Vault, and read a
  secret from it. Needs the owner's unseal keys.
- A real Backstage "Create" of a new service since the Gateway and IRSA
  changes (the offline render passes; see section 13).

### Suggested commit

`docs(phase-9): close out Wave 1 ($0 work)`

### Diagram updates needed

- Edge: Gateway (shared, namespace `gateway`) → HTTPRoute per service;
  remove any remaining Ingress.
- ObjectBucket flow, two variants: MinIO user + key (kind) and S3 +
  IAM role via OIDC (EKS), meeting at the same Secret name.
- New "cost controls" diagram: preflight → session → timer / aws-down →
  audit, with what each one stops.

### LinkedIn post idea

"My side project's cloud bill was 2x the estimate and I found out four
months later. I didn't add a budget alert; I already had four, and they
all fired after the money was gone. What I added instead: a deploy that
refuses, a teardown that proves itself, and a timer that doesn't need
me. Total cost of building all of it: one cent."

### YouTube video idea

"cdk destroy said 'complete'. It wasn't." A walk through why
CloudFormation cannot see what Kubernetes controllers create, a
read-only audit that can, and the ordered teardown tested against a fake
AWS that records every delete, including the tests failing when the
safety checks are removed.

## Wave 2 — deferred until the cap is raised

The live EKS session. Before it:

- Raise `BUDGET_CAP_USD` in the Makefile and the cap in docs/COST.md in
  one commit (owner's decision; `make aws-preflight` refuses until then).
- Confirm the timer's email subscription (the timer itself is deployed).

During it:

- NLB in place of host ports, Let's Encrypt DNS-01 for the wildcard,
  Route53 provider for external-dns.
- Create the `idp-cluster` EnvironmentConfig, limit the Crossplane
  provider's IAM rights to `role/idp-*` and `policy/idp-*`, switch the
  XRD's default Composition to S3.
- First-run checks: a pod reads its bucket with no stored key; the
  load-balancer controller's names and tags match what the teardown
  sweep expects; `make aws-down` ends "complete and verified".

## See also

- [ADR-0033](../adr/0033-edge-routing-via-gateway-api.md) — edge routing via the Gateway API
- [COST.md](../COST.md) — spend, estimates, guardrails
- [Phase 8 log](phase-8-security-hardening.md) — the outages that led to the app-health alerts
