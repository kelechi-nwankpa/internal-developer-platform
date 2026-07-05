# 0003 — Use Crossplane for per-service infrastructure

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

The headline feature of this IDP is *"a developer clicks a button and gets a running service in 10 minutes"* — which requires provisioning AWS resources (RDS databases, S3 buckets, Secrets Manager entries, IAM roles) **on demand, hundreds of times, by developers who have no AWS console access**.

The baseline layer ([ADR-0002](0002-use-aws-cdk-for-baseline-infra.md)) is a poor fit for this: CDK stacks exist once per environment, take minutes to deploy, and require CloudFormation permissions. Handing every developer CDK + `iam:PassRole` + CloudFormation permissions creates massive blast radius and undermines the whole point of a platform.

We need a **provisioning API** that:

- Lets developers request resources via a Kubernetes-native interface (which they already have).
- Enforces platform policy at the request layer (allowed instance types, mandatory tags, region locks).
- Composes with our GitOps pipeline (ArgoCD) so provisioning is auditable and versioned.

## Decision drivers

- Developer experience — devs should never touch the AWS console or CloudFormation.
- Blast radius — no dev-scoped IAM should be able to provision arbitrary AWS resources.
- Composability with ArgoCD — provisioning must be Git-driven.
- Consistency of API surface — one abstraction layer for compute, data, and secrets.
- Multi-cloud readiness (future) — the abstraction shouldn't be AWS-locked at the API level.

## Options considered

### Option A — Crossplane (with provider-aws)

Kubernetes-native control plane for external resources. Exposes AWS resources as Kubernetes Custom Resources (CRs). Compositions (XRDs) let us build higher-level abstractions like `PostgresDatabase` that hide the raw RDS complexity.

- Pros: Single K8s API for everything. Composes naturally with ArgoCD and Kyverno policies. XRDs let platform team expose *opinionated* abstractions. Multi-cloud when needed. GitOps-native.
- Cons: Younger than Terraform — occasional API churn between versions. Debugging failed reconciliation requires understanding both K8s controllers and AWS APIs.

### Option B — Terraform + Atlantis

Terraform modules per service, applied via a PR-driven runner (Atlantis).

- Pros: Mature. Huge module ecosystem. Widely known in industry.
- Cons: Not K8s-native — devs must learn Terraform syntax alongside K8s. State-file management. No unified control plane for K8s + AWS. Fits less naturally with ArgoCD.

### Option C — CDK per service

Each service ships its own CDK stack.

- Pros: Same tool as the baseline; no new concepts.
- Cons: Every dev needs CI credentials to deploy CloudFormation. Massive blast radius. CloudFormation stack sprawl. Doesn't scale past ~50 services.

### Option D — AWS Controllers for Kubernetes (ACK)

AWS-official K8s controllers for AWS services.

- Pros: Vendor-supported, close to AWS APIs.
- Cons: AWS-only. No composition layer — devs get raw resource CRs, not opinionated abstractions. Uneven service coverage.

### Option E — Config Connector

Google Cloud's equivalent.

- Pros: Mature.
- Cons: GCP only. Not usable here.

## Decision

We chose **Option A — Crossplane**. The killer feature is **Compositions (XRDs)** — the platform team defines an XRD like `PostgresDatabase` that expresses the *contract* (size, retention, backup schedule, encryption), and the composition maps it to the actual AWS primitives (RDS instance + parameter group + subnet group + KMS key + Secrets Manager entry). Developers request a `PostgresDatabase`; they never see RDS. This is exactly the abstraction shape a mature platform team ships.

Composing with ArgoCD is the second load-bearing win: Crossplane resources are just CRs in Git, reconciled by ArgoCD, gated by Kyverno, auditable in the K8s audit log. No separate control plane.

We accept the maturity risk. Where breakage happens, it's typically at the provider version boundary, which we can pin and roll deliberately.

## Consequences

- **Positive:** Unified K8s API for developers. Platform team owns abstractions via XRDs. Full GitOps traceability. Kyverno can enforce policy at request time. Provisioning failures surface in the same tools as everything else.
- **Negative:** Extra runtime component (Crossplane controllers + provider). Version churn requires vigilance. Debugging failed provisioning requires understanding both K8s reconciliation and AWS API errors.
- **Neutral:** Compositions live in Git as CRDs — additional artefacts to maintain.

## When to revisit

- If Crossplane's roadmap stalls or the project's governance changes materially.
- If we need cross-cloud provisioning that Crossplane can't handle.
- If AWS ships a native equivalent (unlikely but possible).
- If our composition library becomes so complex it justifies moving to Terraform modules for maintainability.

## Related decisions

- [ADR-0002](0002-use-aws-cdk-for-baseline-infra.md) — the baseline layer that Crossplane runs *inside of*.
- [ADR-0004](0004-single-region-with-multi-region-readiness.md) — single-region assumption bounds provider scope.

## References

- [Crossplane docs](https://docs.crossplane.io/)
- [Crossplane provider-aws](https://github.com/crossplane-contrib/provider-upjet-aws)
- [Composition and CompositeResourceDefinitions](https://docs.crossplane.io/latest/concepts/composite-resources/)
