# CLAUDE.md — AI Collaborator & Contributor Guide

This file exists so that a fresh AI session (or a new human contributor) landing in this repo reaches **~80% project context in 2 minutes**. Read this in full before proposing changes.

---

## 1. Mission (one paragraph)

Build a **production-grade Internal Developer Platform (IDP)** that reduces new-microservice onboarding from ~2 days to ~10 minutes. Backstage as the developer portal; EKS as the runtime; ArgoCD for GitOps continuous delivery; Crossplane as a Kubernetes-native infrastructure API; AWS CDK for the substrate baseline. The project doubles as a **portfolio piece** for a Platform Engineering / Cloud Architect career jump.

---

## 2. How the human wants to work

Non-negotiables — every session must honour these.

- **Deep learning over speed.** The point of the project is to make the engineer, not just to ship the platform. Explanations are load-bearing, not decorative.
- **Small, sequential tasks.** Break work into digestible sub-tasks. Wait for the user to confirm each before starting the next. Never batch multiple non-trivial steps.
- **Every decision explains WHY.** Include alternatives considered, why they were rejected, the trade-offs, and when the alternative would be right. Never justify with "best practice" alone.
- **Every phase follows the same intro shape.** Business problem → target users → business value → architecture → components → data flow → security → operations → future improvements. **Only then** implement.
- **PR-style review after every meaningful section.** Point out design, maintainability, scalability, security, reliability, readability concerns.
- **Never dump code without explanation.** For every file created, explain *why the file exists* and *why the choices in it were made*.
- **Never assume the environment.** Don't assume a package is installed, a tool exists, or a prerequisite is done. Check first or state the assumption explicitly.
- **Quiz the user.** Frequently pause to ask "what do you think?", "what could go wrong here?", "what would a Staff engineer challenge?"
- **End of each phase deliverable.** Summary, key concepts, tech touched, interview talking points, recruiter Q&A, business value delivered, suggested commit, diagram updates, LinkedIn post idea, YouTube video idea.

---

## 3. Budget constraint (hard cap)

- **Total AWS spend must stay under $30.** Target: $15.
- **Default all development to a local `kind` or `k3d` cluster.** AWS is opt-in per session, not baseline.
- **Every `cdk deploy` needs a matching `cdk destroy`** in the same session. Assume the user will forget; design for that.
- **Cost guardrails go in BEFORE any AWS action** — AWS Budgets alarms at $5/$15/$30, cost anomaly detection, `Project=idp` tags, gitleaks pre-commit hook.
- **If a design decision adds monthly cost, flag it explicitly with the dollar figure and ask before proceeding.**
- **Frame local-first as a strength**, not a compromise: "cluster-agnostic, kind for dev, EKS for prod, $0 onboarding" is a stronger interview story than always-on AWS.

---

## 4. Architecture principles

1. **Two-plane separation.** The control plane (Backstage, ArgoCD, Crossplane, GitHub Actions) never mutates the data plane (workloads, RDS, S3) directly. It writes to Git; GitOps reconciles reality → Git.
2. **GitOps-first.** If it isn't in Git, it doesn't exist. Manual `kubectl apply` is a debugging tool, not a workflow.
3. **Local-first.** The platform is portable — `kind` for development, EKS for demo/prod. Same manifests, same behaviour.
4. **Deny-by-default security.** IAM, NetworkPolicy, Kyverno, `.gitignore` — every access decision starts from "no" and whitelists exceptions.
5. **Every non-obvious decision becomes an ADR.** `docs/adr/`. Future contributors should never have to re-derive rationale.
6. **Observability before features.** Metrics/logs/traces are wired up in Phase 3, before Backstage arrives in Phase 5. Debugging is only cheap when it's already built.
7. **Cost visibility.** Every architectural choice includes its cost implication. See `docs/COST.md`.

---

## 5. Repository layout

| Path | Purpose | Introduced in |
|---|---|---|
| `infra/` | AWS CDK — VPC, EKS, ECR, Route53, KMS, IAM baseline | Phase 1 |
| `platform/` | In-cluster components — ArgoCD, Crossplane, observability, security | Phases 2–4, 8 |
| `portal/` | Backstage app + custom plugins | Phase 5 |
| `templates/` | Golden path software templates | Phase 6 |
| `docs/architecture/` | C4 / sequence / infra diagrams | Phase 0 |
| `docs/adr/` | Architecture Decision Records | Phase 0 |
| `docs/runbooks/` | Ops procedures per failure mode | Phases 8–9 |
| `docs/phases/` | Phase-by-phase build log | Phase 0 |
| `docs/COST.md` | Projected + actual AWS spend | Phase 0 |
| `.github/` | CI workflows, PR/issue templates, CODEOWNERS | Phase 0 |
| `Makefile` | One-command surface: bootstrap, lint, aws-up, aws-down | Phase 0 |

---

## 6. Phase and task workflow

- Work is organised into **10 phases** (see `docs/phases/README.md`).
- Each phase begins with a **strategic intro** (problem → users → architecture → …), only then implementation.
- Within a phase, work is broken into numbered **sub-tasks** (`0.1`, `0.2`, `0.3`, …).
- One task in progress at a time. Todo list mirrors this. Never jump ahead.
- Every meaningful section ends with a **PR-style review** — even if the reviewer is the same session that wrote the code.

---

## 7. Commit style

- **Conventional commits.** `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`.
- Present-tense imperative — "add ArgoCD helm chart", not "added" or "adds".
- Reference ADR numbers in the body where relevant: `Refs: docs/adr/0003-use-crossplane-for-dynamic-infra.md`.
- Small, focused commits — one logical change per commit.
- **Never `git push --force`** on `main`. Rebase locally, push cleanly.
- **Never commit secrets or `.env` files.** Pre-commit hook (gitleaks) will catch, but don't rely on it.

---

## 8. Where to look for what

| Question | Directory |
|---|---|
| Why did we pick technology X? | `docs/adr/` |
| How was thing Y built? | `docs/phases/` |
| How do I operate Z when it breaks? | `docs/runbooks/` |
| What does this cost? | `docs/COST.md` |
| What's the overall architecture? | `docs/architecture/` |
| How do I run something? | `Makefile` first, then `docs/phases/<phase>/README.md` |
| What is the AI supposed to know? | this file |

---

## 9. Non-negotiables (hard rules — never violate)

- **No secrets in Git.** Ever. Not even example secrets that "look like" secrets.
- **No always-on AWS resources during development.**
- **No IAM policies with `*:*` or `Resource: "*"` on write actions.** Least privilege, or an ADR justifying the deviation.
- **No `:latest` image tags in Kubernetes manifests.** Pin digests where feasible; tags where not.
- **No `kubectl apply` against real clusters outside a documented runbook.** Everything is GitOps.
- **No decision without a WHY.** If it's non-obvious and not in an ADR, write the ADR.

---

## 10. Current session context

- **AWS region:** `eu-west-1` (Ireland)
- **GitHub:** personal account (no org)
- **Local runtime:** Docker Desktop → `kind`
- **Node.js:** 22 LTS (see `.nvmrc`)
- **Language:** TypeScript for CDK and Backstage; YAML for K8s and Argo; shell for glue

Current phase and sub-task progress: check the todo list in the active session, or `docs/phases/README.md` if starting cold.
