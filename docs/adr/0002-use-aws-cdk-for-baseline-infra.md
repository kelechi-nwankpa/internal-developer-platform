# 0002 — Use AWS CDK for baseline infrastructure

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

The IDP needs a foundational AWS layer — VPC (multi-AZ), Amazon EKS cluster, ECR registry, Route53 hosted zone, KMS keys, IAM baseline (OIDC provider for IRSA, roles for cluster components) — provisioned via Infrastructure as Code. This baseline exists once per environment and rarely changes; it is distinct from **per-service** infrastructure (RDS, S3, secrets), which is provisioned dynamically as services come and go and is addressed in [ADR-0003](0003-use-crossplane-for-per-service-infra.md).

We need to pick a single tool for the baseline that we can maintain, test, and demonstrate.

## Decision drivers

- Type safety and testability — baseline changes are high-blast-radius; a typo shouldn't take down the platform.
- Author skill — the author's primary language is TypeScript.
- AWS-native support — first-class access to new AWS services.
- Ecosystem tooling — security linting (cdk-nag), snapshot testing.
- Portfolio value — the tool should signal senior AWS proficiency.
- Ability to synth locally without deploying (aligns with [ADR-0005](0005-local-first-development-with-kind.md)).

## Options considered

### Option A — AWS CDK (TypeScript)

Amazon's official IaC toolkit; compiles to CloudFormation.

- Pros: Real code (types, unit tests, IDE support). `cdk-nag` for CIS/NIST/AWS-best-practice compliance checks. `cdk synth` produces deterministic templates for review. TypeScript matches author's skill. First-class new-service support.
- Cons: Locked to CloudFormation's limits (custom resource verbosity, refactor pain when renaming logical IDs). Smaller community than Terraform.

### Option B — Terraform

HashiCorp's IaC standard.

- Pros: Largest community. Multi-cloud. Mature module ecosystem (VPC module, EKS Blueprints).
- Cons: HCL is a DSL, not a general-purpose language — testing and abstraction are weaker. State-file management adds operational surface. Author already knows Terraform through GitLab CI — smaller portfolio delta.

### Option C — Pulumi

IaC in real programming languages, similar shape to CDK.

- Pros: Multi-cloud, real code, strong TypeScript support.
- Cons: Smaller community than CDK for AWS-specific work. Requires Pulumi service or self-hosted backend for state. Less recognised on job specs.

### Option D — Raw CloudFormation

YAML/JSON templates directly.

- Pros: No abstraction, no build step.
- Cons: Verbose, no types, no reuse patterns beyond nested stacks. Not a defensible choice in an interview.

### Option E — Manual console clicks

No IaC.

- Pros: Fast for one-off exploration.
- Cons: Not reproducible; not defensible; disqualifies the project from being a portfolio piece.

## Decision

We chose **Option A — AWS CDK (TypeScript)**. The type safety and testability advantage matters more than Terraform's ecosystem breadth for a solo project where the author will maintain every line. TypeScript aligns with the Backstage stack in later phases, giving one language across most of the codebase. `cdk-nag` provides automated security compliance checks — a strong story for [ADR-0001](0001-record-architecture-decisions.md)'s security narrative.

Terraform is a valid alternative — a Staff engineer challenging this decision would rightly point out that Terraform is more common in production AWS shops. We accept that trade-off in exchange for TypeScript-first ergonomics and stronger testability.

## Consequences

- **Positive:** Compile-time errors catch large classes of bugs. Snapshot tests catch drift. `cdk-nag` catches security regressions. One language across the CDK and Backstage phases.
- **Negative:** Locked to CloudFormation as delivery mechanism (its limits become ours — e.g. resource replacement semantics, custom-resource verbosity). Occasional need to write escape-hatch CloudFormation.
- **Neutral:** Requires a Node/TypeScript toolchain in every environment that synthesises.

## When to revisit

- If we need multi-cloud provisioning at the baseline layer.
- If CloudFormation's limits become a persistent friction (e.g. long stack deploys, resource churn).
- If a hiring org's tech stack is Terraform-first and portfolio parity matters more than the current decision.

## Related decisions

- [ADR-0003](0003-use-crossplane-for-per-service-infra.md) — per-service infra is a *different* problem with a *different* tool.
- [ADR-0005](0005-local-first-development-with-kind.md) — how we work with CDK without always-on AWS.
- [ADR-0006](0006-gitignore-cdk-context-json.md) — CDK-specific handling of context caching.

## References

- [AWS CDK docs](https://docs.aws.amazon.com/cdk/)
- [cdk-nag](https://github.com/cdklabs/cdk-nag)
