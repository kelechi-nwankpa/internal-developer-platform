# 0008 — Customer-managed KMS keys, one per data domain

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

The platform encrypts data in several places:

- **Kubernetes Secrets** — envelope-encrypted at the EKS control plane.
- **CloudWatch log groups** — VPC flow logs (already shipping from VpcStack), EKS control plane logs, workload logs.
- **ECR image layers** — encrypted at rest in ECR repositories.

For each, AWS offers two options:

1. **AWS-managed keys** (`aws/eks`, `aws/logs`, `aws/ecr`) — free, opaque, shared across every principal in the account with the relevant IAM.
2. **Customer-managed keys (CMKs)** — $1/month each, custom key policy + IAM, cross-account grants possible, auditable in CloudTrail with per-request detail.

The choice is not primarily technical — either works — but it defines the security story the platform tells.

## Decision drivers

- Portfolio credibility for the security narrative.
- Blast radius of a compromised key.
- Cost (already covered by the $30 budget).
- Auditability requirements as the platform grows.

## Options considered

### Option A — AWS-managed keys everywhere

Use `aws/eks`, `aws/logs`, `aws/ecr`. Zero KMS spend. No CDK infrastructure.

- Pros: Free. Zero maintenance. Fewer resources to manage.
- Cons: Key policy is opaque (a fixed AWS-managed statement). Can't restrict access to specific IAM principals. Doesn't tell a strong security story. If we ever cross-account, we'd have to migrate.

### Option B — One shared customer-managed key for the whole platform

A single "platform" CMK used for everything.

- Pros: $1/mo instead of $3/mo. One IAM boundary to reason about.
- Cons: A compromise of that key exposes secrets, logs, AND images at once. Not blast-radius contained. Poor story on data-classification boundaries.

### Option C — One CMK per data domain (chosen)

Three CMKs: `idp/eks-secrets`, `idp/logs`, `idp/ecr`. Each key has its own alias, its own key policy, and its own rotation schedule.

- Pros: Blast-radius contained — compromise of one key isolates to one data domain. Explicit auditability per domain in CloudTrail. Sets up cleanly for cross-account grants (Phase 4+). Portfolio-defensible.
- Cons: 3× $1/mo = $3/mo baseline. More CDK to maintain.

### Option D — One CMK per stack

A key per stack that needs one (VpcStack, EKS stack, ECR stack). More granular but overlaps with data domains, and if two stacks share a domain the isolation collapses.

- Pros: Very fine-grained. Easy to reason per-stack.
- Cons: Contradicts the "encryption is a data property" framing — a workload log encrypted with an EKS key and a control-plane log encrypted with a different key don't isolate meaningfully.

## Decision

We chose **Option C — one CMK per data domain**. The three keys are `idp/eks-secrets`, `idp/logs`, `idp/ecr`. Each has:

- **Annual rotation enabled.** Free with CMKs. AWS rotates the underlying key material and re-encrypts data-in-place at read time.
- **`RemovalPolicy.DESTROY` + 7-day pending window.** Minimum window that AWS allows. In production we'd use 30 (the default), but for dev iteration 7 lets iterative deploy/destroy cycles reclaim aliases quickly.
- **Default account-root key policy** granting `kms:*` to `arn:aws:iam::ACCOUNT:root` — CDK's default. This is what allows IAM-based grants to work later.

## Consequences

- **Positive:** Blast-radius containment per data domain. Auditable per domain in CloudTrail. Cross-account grants possible without migration. Clear "each key does one job" story.
- **Negative:** ~$3/month always-on ($1 per key). Not concerning under our deploy/destroy discipline. First stack that costs money even when the code isn't deployed — during the 7-day pending window after destroy, the key still exists and is billed pro-rata. Ballpark: 7 days × 3 keys × $1/30-days ≈ $0.70 of residual cost per destroy.
- **Neutral:** Downstream stacks import these keys via CFN Export/Import (cross-stack refs). Renaming or removing a key later requires unwiring imports first.

## When to revisit

- If key management overhead outgrows benefit — likely at 20+ keys, when centralised key management (AWS KMS multi-region keys, external HSM) becomes appropriate.
- If we need CMK-per-workload rather than CMK-per-domain (Phase 4+, if multi-tenant becomes a concern).
- If AWS drops the CMK price or introduces a free CMK tier.

## Related decisions

- [ADR-0004](0004-single-region-with-multi-region-readiness.md) — single-region posture bounds CMK region scope.
- [ADR-0007](0007-vpc-endpoints-instead-of-nat-gateway.md) — the KMS interface endpoint added in VpcStack is what lets private workloads reach these keys without egressing.
- Cross-stack import pattern: this stack exposes `eksSecretsKey`, `logsKey`, `ecrKey`; ClusterStack, VpcStack (flow logs), and RegistryStack (Task 1.7) consume them.

## References

- [AWS KMS pricing](https://aws.amazon.com/kms/pricing/)
- [CDK aws_kms.Key](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_kms.Key.html)
- [AWS best practices — CMK per data domain](https://docs.aws.amazon.com/kms/latest/developerguide/best-practices.html)
