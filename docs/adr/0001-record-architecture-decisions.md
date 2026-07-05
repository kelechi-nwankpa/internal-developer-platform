# 0001 — Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

This project makes many architectural decisions across multiple domains: AWS baseline design, in-cluster components, GitOps topology, secrets management, image supply chain, developer portal integrations. Many of these decisions look arbitrary from the outside (why CDK not Terraform? why Crossplane not Terraform? why kind not LocalStack?) but each has real trade-offs that are easy to forget.

Without a discipline for recording *why* choices were made, future contributors — including the future author — will:

- Waste time re-deriving rationale from code and commit messages.
- Silently reverse decisions without understanding what was traded away.
- Be unable to explain the project confidently in interviews or code reviews.

## Decision drivers

- Institutional memory that survives the author's own forgetting.
- Interview-readiness: articulate rationale under pressure without preparation.
- Low friction — if writing an ADR is expensive, ADRs won't get written.
- Reviewability — decisions must be visible in Pull Requests.

## Options considered

### Option A — No formal record

Rely on commit messages, code comments, and memory.

- Pros: Zero overhead.
- Cons: Guaranteed loss of rationale within months. Terrible for interview prep.

### Option B — Nygard-format ADRs

Original 2011 format: Title, Status, Context, Decision, Consequences.

- Pros: Minimal, widely recognised, one-page.
- Cons: Doesn't force articulation of *rejected* options, which is the main reasoning muscle.

### Option C — MADR format

Modern evolution — adds Decision Drivers, Options Considered with pros/cons, and When to Revisit.

- Pros: Structure forces you to articulate what you rejected and why. Better for a portfolio project where reasoning is the point.
- Cons: Slightly more verbose than Nygard.

### Option D — Design docs (Google-style)

Multi-page RFCs.

- Pros: Deep, thorough, industry-recognised at scale.
- Cons: Far too heavyweight for solo/small-team velocity. Would suppress the practice.

## Decision

We chose **Option C — MADR**. The *Options Considered* section is the payload of an ADR; without it, an ADR is barely more than a comment. MADR strikes the right balance between rigour and friction for a solo-owned portfolio project.

## Consequences

- **Positive:** Every non-obvious decision gets a durable, reviewable record. Rationale survives contributor changes. Portfolio interviews become easier — the ADRs *are* the talking points.
- **Negative:** Each architecturally significant PR takes an extra 10–20 minutes to write the ADR.
- **Neutral:** ADRs are numbered and immutable — old ADRs remain even after being superseded.

## When to revisit

- If ADRs stop getting written despite decisions being made — indicates friction is too high; consider Y-statements for a lighter format.
- If the ADR count exceeds ~50 without an index refactor — split by domain (`docs/adr/infra/`, `docs/adr/security/`).

## Related decisions

- None (this is the meta-ADR).

## References

- [Nygard, *Documenting Architecture Decisions*](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [MADR format](https://adr.github.io/madr/)
