# Cost — projected and actual

- **Hard cap:** $30 total AWS spend across the entire project.
- **Target:** $15.
- **Rationale:** [ADR-0005 — Local-first development with kind](adr/0005-local-first-development-with-kind.md).

---

## Actual spend to date

| Date | Description | AWS charges (USD) | Cumulative |
|---|---|---:|---:|
| 2026-07-02 | Project started; no AWS resources yet | $0.00 | $0.00 |

Updated after every session that touches AWS.

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

---

## Expected AWS spend per phase

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

_None yet._ Add entries here as they happen.

---

## References

- [ADR-0005 — Local-first development with kind](adr/0005-local-first-development-with-kind.md)
- [AWS Pricing Calculator](https://calculator.aws/)
- [AWS Cost Explorer docs](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html)
- [AWS EKS pricing](https://aws.amazon.com/eks/pricing/)
- [AWS NAT Gateway pricing (the classic silent bleeder)](https://aws.amazon.com/vpc/pricing/)
