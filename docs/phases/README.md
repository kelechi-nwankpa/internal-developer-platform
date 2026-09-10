# Phase log

Each phase of this project ships a discrete slice of the platform, with a written record of what was built, what was learned, and what was deferred. These logs double as **portfolio talking points** — a phase log is what turns "I built an IDP" into "in Phase 3, I evaluated Loki against ELK for log aggregation and picked Loki because…".

## Phases

| # | Phase | Status | Log |
|---|---|---|---|
| 0 | Foundations & docs | ✅ shipped | [phase-0-foundations.md](phase-0-foundations.md) |
| 1 | AWS baseline via CDK | ✅ shipped | [phase-1-baseline.md](phase-1-baseline.md) |
| 2 | Cluster add-ons (GitOps'd) — ArgoCD + cert-manager + ESO + Vault + external-dns | ✅ shipped | [phase-2-platform.md](phase-2-platform.md) |
| 3 | Observability stack — Wave 1 (metrics) + Wave 2 (logs + traces) | ✅ shipped | [phase-3-observability.md](phase-3-observability.md) |
| 4 | Crossplane + AWS provider + first XRD (ObjectBucket) | ✅ shipped | [phase-4-crossplane.md](phase-4-crossplane.md) |
| 5 | Backstage MVP — Wave 1 shipped, Wave 2 deferred | ✅ Wave 1 shipped | [phase-5-backstage.md](phase-5-backstage.md) |
| 6 | Golden path template (Node.js) | ⏳ pending | — |
| 7 | CI/CD golden pipeline | ⏳ pending | — |
| 8 | Security hardening | ⏳ pending | — |
| 9 | Cost, DR, ops | ⏳ pending | — |
| 10 | Polish for showcase | ⏳ pending | — |

## What each phase log contains

- **Business problem** — what problem this phase addresses.
- **Target users** — who benefits.
- **Business value** — quantified where possible.
- **What shipped** — files, components, commits.
- **Key decisions** — links to ADRs written during the phase.
- **What was learned** — the "aha" moments.
- **What was deferred** — deliberate cuts, so future-us doesn't rediscover them as gaps.
- **Interview talking points** — the 30-second pitches for this phase.
- **Recruiter Q&A** — anticipated questions and prepared answers.
- **Suggested LinkedIn / YouTube content** — content extraction opportunities.
