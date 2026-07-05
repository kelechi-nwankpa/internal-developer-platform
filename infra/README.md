# infra/ — AWS substrate (baseline)

**Contents:** AWS CDK code that provisions the *one-time, per-environment* AWS foundation this platform runs on.

## What lives here

- VPC (multi-AZ, private + public subnets, VPC endpoints where they save NAT costs).
- Amazon EKS cluster (control plane + node groups / Fargate profiles).
- ECR registry.
- Route53 hosted zone.
- KMS keys (customer-managed for EKS secrets, CloudWatch, RDS).
- IAM baseline — OIDC provider for IRSA, service-linked roles, cluster admin role.
- AWS Budgets, cost anomaly detection, tagging policies.

## Why this is its own directory

The substrate is **long-lived** (created once per environment, changes rarely) and **high-blast-radius** (a mistake here can break every workload). It is provisioned by a small group with elevated IAM permissions — not by developers.

This is the deliberate opposite of `platform/`, whose contents change constantly and are safely reconciled by ArgoCD; and of Crossplane compositions in `platform/`, which developers *do* touch (indirectly via the portal) to provision *per-service* AWS resources.

See [ADR-0002](../docs/adr/0002-use-aws-cdk-for-baseline-infra.md) for why CDK, and [ADR-0003](../docs/adr/0003-use-crossplane-for-per-service-infra.md) for why per-service infra lives elsewhere.

## When this arrives

**Phase 1.** The directory is empty until then to keep the tree honest about what's implemented.

## Local workflow

Cost discipline (see [ADR-0005](../docs/adr/0005-local-first-development-with-kind.md)) means we usually work here in `cdk synth` mode with unit tests, not `cdk deploy`:

```bash
cd infra
npm run test           # unit + snapshot tests
npx cdk synth          # produces cloudformation into cdk.out/ (git-ignored)
npx cdk diff           # against last-deployed state (requires AWS creds)
```

AWS is opt-in per session — see the top-level `Makefile` (`make aws-up`, `make aws-down`), arriving in Phase 1.

## Relates to

- `platform/` — the in-cluster runtime that this substrate hosts.
- `docs/adr/` — every non-obvious substrate decision (region choice, NAT strategy, IAM structure).
- `docs/COST.md` — the projected + actual spend, driven mostly by what happens here.
