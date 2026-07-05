# Phase 0 — Foundations & docs

- **Status:** 🔄 in progress
- **Started:** 2026-07-02

## Business problem

Before any platform code exists, we need the **thinking scaffolding** that will keep the project coherent as it grows: a documentation structure, a decision log, guardrails against common failure modes (secrets in Git, always-on AWS cost, ad-hoc architectural drift). Skipping this phase is the #1 reason side projects become unreviewable.

## Target users of this phase

- **The author** — needs institutional memory across sessions and phases.
- **Future contributors** — need to reach ~80% context in minutes.
- **Interviewers** — need artefacts they can inspect that demonstrate senior engineering practice.
- **Future AI collaborators** — need durable context (see [`CLAUDE.md`](../../CLAUDE.md)).

## Business value

- Zero-cost — this phase is entirely local documentation and configuration.
- High leverage — every subsequent phase is faster and less error-prone because the guardrails exist.
- Portfolio signal — repos with ADRs, phase logs, and structured docs read at a level above generic side projects.

## What ships in this phase

Tracked as sub-tasks 0.1–0.8. Progress:

| Sub-task | Description | Status |
|---|---|---|
| 0.1 | git init + core dotfiles | ✅ |
| 0.2 | README.md stub + CLAUDE.md | ✅ |
| 0.3 | docs/ scaffolding + first 6 ADRs | ✅ (this file lands here) |
| 0.4 | .github/ scaffolding (CODEOWNERS, PR/issue templates, CI stub) | ⏳ |
| 0.5 | Pre-commit + gitleaks + yamllint + shellcheck | ⏳ |
| 0.6 | Makefile + docs/COST.md | ⏳ |
| 0.7 | Top-level phase directories (`infra/`, `platform/`, `portal/`, `templates/`) | ⏳ |
| 0.8 | First real commit + push to GitHub | ⏳ |

## Key decisions (ADRs written this phase)

- [ADR-0001](../adr/0001-record-architecture-decisions.md) — Adopt MADR-format ADRs.
- [ADR-0002](../adr/0002-use-aws-cdk-for-baseline-infra.md) — Use AWS CDK for baseline infra.
- [ADR-0003](../adr/0003-use-crossplane-for-per-service-infra.md) — Use Crossplane for per-service infra.
- [ADR-0004](../adr/0004-single-region-with-multi-region-readiness.md) — Single region deployment, multi-region-ready design.
- [ADR-0005](../adr/0005-local-first-development-with-kind.md) — Local-first development with kind.
- [ADR-0006](../adr/0006-gitignore-cdk-context-json.md) — Git-ignore `cdk.context.json`.

## What was learned

- The distinction between **mechanically enforceable rules** (secrets in Git, `:latest` tags, `*:*` IAM) and **culturally enforced rules** (decision rationale, PR discipline) — and that Staff engineering practice is largely about making cultural rules cheap to follow (templates, PR-template fields, CODEOWNERS gating).
- The two-plane mental model (control plane vs data plane) is the single most useful lens for reasoning about platform architecture.
- ADRs are not just documentation — they are a *thinking tool*. The act of listing rejected options surfaces trade-offs you'd otherwise glide past.
- For a portfolio project, going *against* an official recommendation (like committing `cdk.context.json`) is only defensible with an explicit written rationale. Without the ADR, it looks like ignorance; with it, it looks like judgement.

## What was deferred

- Substantive Backstage + CDK setup — those phases don't start until the guardrails are in place.
- Cost dashboards — projected costs live in `docs/COST.md`; actual dashboarding waits for Phase 9.
- Architecture diagrams — placeholder in `docs/architecture/`; first real diagram in Phase 1.

## Interview talking points

- *"I structured the project so the first commit already had a decision log, non-negotiable rules, and cost transparency — that discipline is what separates a portfolio piece from a demo."*
- *"I picked MADR over Nygard because the Options-Considered section forces me to articulate what I rejected, which is the reasoning muscle interviewers listen for."*
- *"For non-obvious decisions like git-ignoring `cdk.context.json` I wrote an ADR explaining why I went against the AWS-recommended default — because in this project's context (public repo, few deploys), the reproducibility win didn't outweigh the leakage risk."*

## Recruiter Q&A prep

- **Q: Why do you have 6 ADRs before writing any code?** *A: To make the reasoning inspectable. The code shows what; the ADRs show why. A repo without ADRs is a repo you have to read line-by-line to understand.*
- **Q: What's the budget?** *A: $30 hard cap, $15 target. Achieved by defaulting to local `kind` and treating AWS as opt-in per session. Details in `docs/COST.md`.*

## Content extraction ideas

- **LinkedIn post:** "6 ADRs before 6 lines of code — why I front-loaded architecture decisions on my new Platform Engineering side project"
- **YouTube video:** "Setting up a Platform Engineering side project like a senior engineer would — docs, ADRs, guardrails on day one"
- **Blog post:** "MADR vs Nygard vs Y-statements — picking an ADR format for a solo project"
