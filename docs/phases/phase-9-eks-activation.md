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
  for hostPort 80/443. Audit and warn stay at `baseline`.

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

## Still to do (all $0 on kind)

- An off-node backup of Vault's data (or accept re-issuing the secrets).
- Move the Backstage Postgres password to Vault + ExternalSecret.
- Kyverno rule limiting the `gateway` namespace to hostPorts 80/443.
- Decide whether external-dns should publish the wildcard record that the
  redirect route produces (`*.idp.seniormankelz.dev`).
- S3/IRSA Composition meeting the five-key bucket contract, tested
  offline with `crossplane render`.
- Teardown ordering, audit script, auto-teardown timer.

## Deferred until the cap is raised

- The live EKS session: NLB in place of host ports, Let's Encrypt DNS-01
  for the wildcard, Route53 provider for external-dns.

## See also

- [ADR-0033](../adr/0033-edge-routing-via-gateway-api.md) — edge routing via the Gateway API
- [COST.md](../COST.md) — spend, estimates, guardrails
- [Phase 8 log](phase-8-security-hardening.md) — the outages that led to the app-health alerts
