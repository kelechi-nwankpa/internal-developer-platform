# 0007 — VPC Interface endpoints instead of a NAT Gateway

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Every EKS workload needs egress to at least a handful of AWS services (ECR, CloudWatch Logs, STS, KMS). By default a VPC has no such egress path: private subnets can't reach the internet, and workloads can't reach any AWS API without one of the following:

1. **NAT Gateway** — routes internet-bound traffic. Managed by AWS. ~$33/mo baseline + data.
2. **NAT Instance** — a small EC2 instance running NAT with `iptables`. ~$3/mo baseline, but self-managed.
3. **VPC Interface endpoints** — private ENIs that terminate each AWS service. ~$7.20/mo per endpoint per AZ.
4. **VPC Gateway endpoints** (S3, DynamoDB only) — route-table entries. Free.

An earlier framing in this project ([`docs/COST.md`](../COST.md)) presented "no NAT" as a cost-optimisation. That's misleading — the honest math shows that Interface endpoints in a 3-AZ VPC actually cost more than a single NAT Gateway *if the platform runs always-on*. Our deploy/destroy discipline (see [ADR-0005](0005-local-first-development-with-kind.md)) makes per-session cost pennies for either approach.

The real decision is therefore **architectural**, not financial.

## Decision drivers

- Blast radius on a compromised workload pod.
- Portfolio credibility — what a Staff platform engineer would ship.
- Cost per session (both options are similar under our workflow).
- Test setup complexity.

## Options considered

### Option A — NAT Gateway (managed, 1 × single AZ)

Route table entry `0.0.0.0/0 → NAT Gateway` on private subnets. Pods can reach any internet destination.

- Pros: Simplest. Zero endpoint management. Workloads can reach Docker Hub, GitHub, external APIs.
- Cons: A compromised pod can exfiltrate to the internet. Weakens the security story. Cost per session is negligible but always-on cost is ~$33/mo.

### Option B — NAT Instance (t4g.nano, self-managed)

An EC2 instance with `net.ipv4.ip_forward=1` and IPtables masquerade routing.

- Pros: Very cheap (~$3/mo always-on). Interesting "understand-the-plumbing" portfolio talking point.
- Cons: Single-point-of-failure. Requires OS patching. Not what a modern platform team ships.

### Option C — VPC endpoints only (chosen)

Gateway endpoints for S3 + DynamoDB (free). Interface endpoints for the minimum set of AWS services the platform needs (ECR api, ECR dkr, CloudWatch Logs, STS, KMS). No route to the internet at all from private subnets.

- Pros: A compromised pod cannot reach the public internet. Every AWS API call is auditable via VPC Flow Logs. Demonstrates "no-internet workload isolation" — a real production hardening pattern.
- Cons: Higher always-on cost (~$110/mo for 5 endpoints × 3 AZs). Not a limitation with our deploy/destroy discipline (~$0.60 per session). Workloads that need Docker Hub or external APIs must proxy or pull-through-cache. This is a Phase 6+ concern (ECR pull-through cache).

### Option D — Hybrid: NAT Gateway + Gateway endpoints (S3/DynamoDB free)

Gateway endpoints for S3/DynamoDB (avoid data-transfer through NAT), NAT Gateway for everything else.

- Pros: Balances flexibility (internet available) with cost (S3 traffic bypasses NAT — Docker image layer pulls are 90%+ of egress, so this alone saves real money).
- Cons: Doesn't achieve "no-internet-from-workloads" security posture.

## Decision

**We chose Option C — VPC endpoints only.** The security posture (compromised-pod blast radius contained to AWS-service traffic) is a real Staff-level design choice that a portfolio should demonstrate. Our deploy/destroy discipline makes the per-session cost trivial.

We explicitly note that in a shared-tenancy production account where the stack ran always-on 30 days a month, Option D would probably be the correct choice — the flexibility gain per marginal dollar is high. Our project's workflow (short-lived deploys, no persistent workloads) tips the balance to Option C.

## Consequences

- **Positive:** Deny-by-default network posture. VPC Flow Logs capture every egress attempt. Real production talking point. Interface endpoints scoped to a security group that only allows 443/tcp from the VPC CIDR.
- **Negative:** Workloads that need Docker Hub / GitHub egress must route through an ECR pull-through cache (Phase 6+). Higher always-on cost — not a concern for us, would be for a real production team.
- **Neutral:** Bumps our per-session AWS cost by ~$0.50. Well within budget.

## When to revisit

- If we adopt a workload that legitimately needs egress to a non-AWS service (Docker Hub, external API) and pull-through caching isn't sufficient.
- If AWS drops Interface endpoint pricing meaningfully.
- If the platform ever runs always-on (production posture) — reconsider Option D.

## Related decisions

- [ADR-0004](0004-single-region-with-multi-region-readiness.md) — the single-region context this decision lives within.
- [ADR-0005](0005-local-first-development-with-kind.md) — deploy/destroy discipline that neutralises the "cost of always-on endpoints" concern.
- The [`docs/COST.md`](../COST.md) framing of "no NAT saves $32/mo" should be superseded by this ADR — the actual decision is architectural, not financial.

## References

- [AWS PrivateLink pricing](https://aws.amazon.com/privatelink/pricing/)
- [Amazon VPC endpoint services](https://docs.aws.amazon.com/vpc/latest/privatelink/concepts.html)
- [EKS best practices — networking](https://aws.github.io/aws-eks-best-practices/networking/)
