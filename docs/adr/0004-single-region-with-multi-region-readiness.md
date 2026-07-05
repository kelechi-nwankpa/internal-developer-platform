# 0004 — Single region deployment, multi-region-ready design

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

A production-grade platform normally supports multi-region deployment for disaster recovery, latency, and compliance. Multi-region is also **substantially more expensive and operationally complex**: extra EKS control-plane costs (~$73/mo per region), ECR replication charges, cross-region VPC peering or Transit Gateway, RDS global databases, data-residency considerations, and duplicated GitOps pipelines.

For this project the budget cap is $30 total AWS spend (see [ADR-0005](0005-local-first-development-with-kind.md)). Multi-region is not financially achievable. But for portfolio and interview credibility, the platform must **articulate a defensible multi-region strategy**, even if we don't run it.

## Decision drivers

- Cost — $30 total budget precludes running two regions.
- Interview credibility — a Staff-level candidate must be able to design multi-region even if they can't afford to deploy it.
- Simplicity of the demo — cross-region complexity would distract from the core IDP value story.
- Future-proofing — we should not paint ourselves into design corners that a real multi-region rollout would have to unpick.

## Options considered

### Option A — Single region only, no multi-region posture

Just pick eu-west-1 and move on.

- Pros: Simplest possible design.
- Cons: Fails the interview credibility test. Reviewers will ask about DR and we'll have nothing.

### Option B — Active-active multi-region (deployed)

Two regions running the same platform, DNS-load-balanced.

- Pros: Real, demonstrable DR and latency benefits.
- Cons: Blows the budget by ~5×. Doubles operational complexity for a solo project. Overkill for a portfolio piece.

### Option C — Active-passive multi-region (deployed)

Warm standby in a second region, promoted on failover.

- Pros: Cheaper than active-active. Still demonstrable.
- Cons: Still exceeds budget (~2× cost). Failover procedure is complex to build and demo.

### Option D — Single region deployed, multi-region-ready design (chosen)

Deploy only in eu-west-1. Design all components so a second region could be added without redesign. Document the multi-region rollout as a runbook.

- Pros: Fits budget. Preserves interview credibility. Forces the design discipline that would make a real rollout possible.
- Cons: The multi-region story is aspirational, not demonstrated. Reviewers may ask to see it work.

## Decision

We chose **Option D**. The deployment is single-region (eu-west-1); the *design* is deliberately multi-region-ready. Concretely, this means:

- **Route53** (global by design) — hosted zone at the account level; we plan for `latency-based` or `geolocation` routing to be added by editing records, not by rearchitecting.
- **ECR** — single region for now; ECR replication is documented as a one-config-change addition in the deployment runbook.
- **EKS** — per-region; a second-region cluster would be a duplicate of the CDK stack parameterised by region.
- **RDS** — single-region; RDS Multi-AZ is on within-region for HA. RDS Global Database is documented as the multi-region path.
- **State** — no application state pinned to a single AZ; all persistent state either in RDS (multi-AZ) or S3.
- **CI/CD** — GitHub Actions and ArgoCD are region-agnostic; adding a second region is another ArgoCD `ApplicationSet` targeting a new cluster.

The multi-region rollout will be captured as a **runbook** in `docs/runbooks/multi-region-expansion.md` (to be written in Phase 9).

## Consequences

- **Positive:** Cost stays within budget. Interview story: *"designed for multi-region, deployed single-region — here's exactly what would change to expand"* is stronger than either extreme. Design discipline is forced early.
- **Negative:** DR cannot be demonstrated in the running system; only in documentation. Reviewers may push on this and we should have crisp answers ready.
- **Neutral:** Region choice (eu-west-1) locks us to Ireland pricing and AZ topology; not consequential at this scale.

## When to revisit

- If a real business use-case emerges (compliance, latency requirement).
- If a hiring conversation requires demonstrable DR — deploy to a second region temporarily as an interview prep exercise.
- If costs drop materially (e.g. AWS ships a smaller EKS SKU).

## Related decisions

- [ADR-0005](0005-local-first-development-with-kind.md) — the budget constraint driving this decision.

## References

- [AWS Well-Architected — Reliability Pillar (Multi-Region)](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/plan-for-disaster-recovery-dr.html)
