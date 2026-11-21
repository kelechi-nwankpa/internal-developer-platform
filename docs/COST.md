# Cost — projected and actual

- **Hard cap:** $30 total AWS spend across the entire project.
- **Target:** $15.
- **Rationale:** [ADR-0005 — Local-first development with kind](adr/0005-local-first-development-with-kind.md).

---

## Actual spend to date

| Date | Description | AWS charges (USD) | Cumulative |
|---|---|---:|---:|
| 2026-07-02 | Project started; no AWS resources yet | $0.00 | $0.00 |
| 2026-07 | Phase 1: EKS baseline up for 23.3 hours across deploy/validate cycles (breakdown below) | $27.17 | $27.17 |
| 2026-08 → 2026-11 | Idle: CostStack + Cost Explorer requests only (~$0.004/month) | $0.01 | $27.19 |

Updated after every session that touches AWS. Figures are from Cost
Explorer (`aws ce get-cost-and-usage`, $0.01 per request), not estimates.

**Status (2026-11-21): $27.19 of the $30 cap spent; about $2.80 left.**
Per the "$25 alarm" runbook below, AWS work is paused: Phase 9 is being
completed at $0 on kind (offline EKS-readiness proofs). A live EKS
session needs the owner to raise the cap first.

### Where Phase 1's $27.17 went (Cost Explorer, July 2026)

| Line item | Usage | USD | Share | Avoidable? |
|---|---|---:|---:|---|
| EKS **extended-support** surcharge | 23.3 h × $0.50 | 11.65 | 43% | **Yes** — pin a Kubernetes version in standard support |
| VPC Interface endpoints | 636 endpoint-hours × $0.011 (9 endpoints × 3 AZs) | 7.00 | 26% | Mostly — fewer endpoints/AZs, or NAT for a short session |
| Tax (20% VAT) | on all of the above | 4.53 | 17% | No — **every estimate must include it** |
| EKS control plane (standard) | 23.3 h × $0.10 | 2.33 | 9% | No |
| Fargate (vCPU + memory) | 10.9 vCPU-h + 21.8 GB-h | 0.54 | 2% | No |
| Route 53 hosted zone | 1 zone | 0.50 | 2% | Only if deleted within 12 h |
| KMS keys | 3 keys, prorated | 0.44 | 2% | No |
| Cost Explorer API | 19 requests × $0.01 | 0.19 | 1% | Yes — batch queries |

Effective run rate in Phase 1: **about $1.14 per hour including tax.**

---

## Projected production footprint (for context — we do NOT run this)

This is the approximate monthly cost of the **always-on** version of the platform we're designing. It exists here so that (a) the [ADR-0005](adr/0005-local-first-development-with-kind.md) trade-off is grounded in real numbers, and (b) an interviewer sees we understand the real cost profile of what we've built.

| Component | Rate | Monthly (USD) |
|---|---|---:|
| EKS control plane | $0.10/hr | ~$73 |
| Worker nodes (2× t3.medium on-demand) | $0.0416/hr each | ~$60 |
| NAT Gateway (1× single AZ) | $0.045/hr + data | ~$32 baseline |
| Application Load Balancer | $0.0225/hr + LCU | ~$16 |
| RDS db.t4g.micro Multi-AZ | on-demand ~$0.033/hr | ~$24 |
| EBS gp3 (~100 GB pool) | $0.08/GB-mo | ~$8 |
| CloudWatch Logs (10 GB ingest) | $0.50/GB ingest | ~$5 |
| Secrets Manager (10 secrets) | $0.40/secret/mo | ~$4 |
| KMS keys (2× customer-managed) | $1/key/mo | ~$2 |
| Route53 hosted zone | $0.50/zone/mo | ~$0.50 |
| ECR storage (~5 GB) | $0.10/GB-mo | ~$0.50 |
| **Total (always-on)** | | **~$225/mo** |

---

## How we stay under $30

1. **Local `kind` cluster for Phases 2–9.** Everything in-cluster (ArgoCD, Crossplane, cert-manager, ESO, observability, Backstage) develops against a local kind cluster. Zero AWS cost.
2. **`cdk synth` + unit tests, not `cdk deploy`.** Phase 1's CDK code is developed and tested locally. AWS resources exist only for validation runs.
3. **Teardown discipline.** Every session that touches AWS ends with `make aws-down`. Every one.
4. **No NAT Gateway in the demo cluster.** Public subnets for demo nodes, VPC endpoints where needed — saves ~$32/mo of silent bleed. Trade-off documented in an ADR when we build the CDK stack.
5. **Fargate spot or a single small node** for the recorded demo — pay per second.
6. **RDS on-demand, destroyed at end of test.** A single day of `db.t4g.micro` costs ~$0.80.
7. **The recorded demo cluster is torn down within 24 hours of recording.** Portfolio value lives in the GitHub repo and the video, not in a running cluster.

---

## Guardrails (implemented in Phase 1 before any AWS deploy)

- **AWS Budgets** alarms at $5, $15, $30, $50 → email.
- **Cost anomaly detection** enabled account-wide (free).
- Every resource tagged **`Project=idp`** so Cost Explorer is surgical.
- **gitleaks** pre-commit + CI — prevents leaked keys leading to crypto-miner bills (the fastest way anyone ever loses $10k+ on AWS).
- **Root MFA + IAM Identity Center** in place before any workload account access.
- **Daily cost pull** via `aws ce get-cost-and-usage`; the [`make cost`](../Makefile) target will surface this locally starting in Phase 1.
- **Deploy preflight** (Phase 9): `make aws-up` runs
  [`scripts/aws-preflight.sh`](../scripts/aws-preflight.sh) first and
  refuses to deploy unless the Kubernetes version in the synthesized
  template is in EKS standard support **and** lifetime spend plus the
  session estimate fits under the cap (`BUDGET_CAP_USD` in the Makefile).
  It fails closed: a check that cannot run is a refusal. Budgets alarms
  only warn after the money is spent; this stops the deploy before it.

---

## Projected cost of one live EKS session (Phase 9, evidence-based)

Built from the Phase 1 unit prices above (same account, same region),
for the Phase 9 design: Fargate-only golden-path slice, NAT Gateway for
the session instead of interface endpoints, Gateway API load balancer.
NAT and load-balancer prices are list prices not yet seen on our own
bill — re-check them on the AWS pricing page before approving a deploy.

| Item | Per hour (USD, before tax) | Source |
|---|---:|---|
| EKS control plane, **standard support** | 0.10 | our bill |
| Fargate, ~15 small pods (0.25 vCPU / 0.5 GB) | ~0.19 | our bill's unit prices |
| NAT Gateway | ~0.05 | list price |
| Network Load Balancer (Gateway) | ~0.03 | list price |
| Public IPv4 addresses (NAT + LB) | ~0.02 | list price |
| **Hourly subtotal** | **~0.39** | |
| **Hourly including 20% VAT** | **~0.47** | |

Fixed costs per session: Route 53 zone $0.50, KMS ~$0.10, NAT data
(~2 GB of image pulls) ~$0.10, Cost Explorer checks ~$0.05; about
**$0.90 including VAT**.

| Scenario | Estimated total (incl. VAT) |
|---|---:|
| Planned: one 3-hour session | **~$2.30** |
| One failed attempt + retry (6 h) | ~$3.70 |
| Session forgotten for 24 h | ~$12 |
| Same 24 h on an extended-support version | ~$27 |
| If interface endpoints are kept as well (18 ENIs) | add ~$0.24/h |

What this means for the cap: the planned session fits in roughly $3, but
a safe margin for one retry plus a mistake is **about $10–12 of
headroom** (i.e. a cap of roughly $40). The two controls that keep it at
the low end are (1) a Kubernetes version in standard support, verified
before deploy, and (2) the automatic teardown timer.

---

## Expected AWS spend per phase

_Original Phase 0 projection, kept for the record. Phase 1 actually cost
$27.17 (see above), so the phases after it must be re-planned: Phase 9
runs at $0 unless the cap is raised, and the Phase 10 recorded demo
(~$10 here) needs the cap raised as well._

| Phase | AWS spend expected | Reasoning |
|---|---:|---|
| 0 — Foundations | $0 | Local docs and config only |
| 1 — CDK baseline | ~$5–15 | 2–3 deploy/destroy cycles to validate the CDK stack |
| 2 — Cluster add-ons | $0 | Everything on local kind |
| 3 — Observability | $0 | Everything on local kind |
| 4 — Crossplane | ~$3 | One integration test hitting real AWS provider |
| 5 — Backstage MVP | $0 | Local dev only |
| 6 — Golden path template | $0 | Local kind + GitHub Actions |
| 7 — CI/CD pipeline | $0 | GitHub Actions free tier on a public repo |
| 8 — Security hardening | $0 | All on local kind |
| 9 — Cost, DR, ops | ~$2 | Cost Explorer / Budgets validation |
| 10 — Polish & demo | ~$10 | Full stack up, record, tear down within 24h |
| **Total projected** | **~$20–30** | Within the hard cap |

---

## What to do at each budget alarm level

Turn "over budget" from panic into runbook.

### $10 alarm — investigate

Check what's still running. Usually a forgotten NAT Gateway or EKS cluster.

```bash
aws eks list-clusters --region eu-west-1
aws ec2 describe-nat-gateways --region eu-west-1 --filter Name=state,Values=available
aws rds describe-db-instances --region eu-west-1
aws elbv2 describe-load-balancers --region eu-west-1
```

### $15 alarm — teardown now

```bash
make aws-down
```

Investigate the root cause **before** any further deploys. Log the incident in this file.

### $25 alarm — stop and reassess

Pause AWS work. Move remaining phases to synth-only local iteration. Consider deferring the recorded demo until we understand the cost pattern.

### $30 alarm — full stop

Shut everything down. Write a short postmortem to `docs/runbooks/cost-overrun.md` capturing: what was left running, why the alarms below $30 didn't catch it, and what guardrail change would prevent recurrence.

---

## Cost incidents log

### 2026-07 — Phase 1 cost $27.17 against a $5–15 projection

- **What happened:** the EKS cluster ran 23.3 hours on a Kubernetes
  version that was already in **extended support**, which adds $0.50/h on
  top of the $0.10/h control plane ($11.65, 43% of the bill). Interface
  endpoints in 3 AZs added $7.00, and 20% VAT was not in the estimate.
- **Why nobody noticed:** the spend noted mid-phase (~$14) was read
  before the month's charges had all landed, and this file was never
  updated with the final figure. The gap was found on 2026-11-21 by a
  Cost Explorer query during Phase 9 planning.
- **Guardrail changes:** (1) verify the Kubernetes version's support
  status before every deploy; (2) include VAT in every estimate;
  (3) read final spend from Cost Explorer a few days after a session and
  record it here; (4) Phase 9 adds an automatic teardown timer and a
  post-teardown audit.

---

## References

- [ADR-0005 — Local-first development with kind](adr/0005-local-first-development-with-kind.md)
- [AWS Pricing Calculator](https://calculator.aws/)
- [AWS Cost Explorer docs](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html)
- [AWS EKS pricing](https://aws.amazon.com/eks/pricing/)
- [AWS NAT Gateway pricing (the classic silent bleeder)](https://aws.amazon.com/vpc/pricing/)
