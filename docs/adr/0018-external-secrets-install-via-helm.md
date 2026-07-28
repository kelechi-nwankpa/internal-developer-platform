# 0018 — Install External Secrets Operator (ESO) via the upstream Helm chart, as an ArgoCD Application

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 2 needs a way to materialise application secrets (database credentials, API tokens, TLS keys used outside cert-manager's scope) from a secure external store into Kubernetes `Secret` objects, without ever passing the secret material through git, CI, or a developer's laptop. External Secrets Operator (ESO) is the accepted community pattern for this.

The install-method choice for ESO is essentially the same shape as the one for cert-manager (see [ADR-0016](0016-cert-manager-install-via-helm.md)) — a well-maintained upstream Helm chart, a well-maintained set of raw manifests, and the option of a completely different install path (direct `helm install` from a laptop, ignored on principle per [ADR-0015](0015-argocd-app-of-apps-pattern.md)).

This ADR records the choice explicitly rather than leaving it implicit. Every "we're doing X because we did X last time" instinct in a growing codebase is a decision worth writing down.

## Decision drivers

1. **GitOps-first.** No manual `helm install`. Anything else defeats the pattern shipped in Task 2.2.f.
2. **Alignment with community norms.** ESO's own docs default to the Helm chart. Every troubleshooting thread on GitHub / Stack Overflow assumes it.
3. **Parameterisation ergonomics.** We'll want to override `serviceMonitor.enabled` (Phase 3), possibly IRSA annotations on the ServiceAccount (Phase 9 EKS), possibly resource limits later. All Helm-values-friendly.
4. **Blast radius on failure.** `argocd app delete external-secrets && kubectl delete crd externalsecrets.external-secrets.io ...` is a clean teardown.
5. **Pattern consistency.** cert-manager (ADR-0016) is Helm-via-ArgoCD. ExternalDNS (Task 2.5) will be. AWS LBC (Task 2.6) will be. Diverging for one component costs more (cognitive) than it saves (nothing).

## Options considered

### Option A — Helm chart via ArgoCD Application (chosen)

`platform/argocd/apps/external-secrets.yaml` is an ArgoCD `Application` sourcing `https://charts.external-secrets.io` chart `external-secrets` at pinned revision `2.8.0`.

- Pros: GitOps-native. Standard for ESO. Parameterisable via `valuesObject` (typed YAML in the Application spec). Upgrades = change one line + merge. Portable across kind and EKS.
- Cons: Same as ADR-0016's Option A — ArgoCD renders the chart on its side of the world, so debug is one layer deeper (`argocd app get external-secrets --show-operation`).

### Option B — Raw manifests via ArgoCD Application

`Application.spec.source.path` points at a directory in this repo containing the ESO raw manifests (from the release page).

- Pros: No Helm; the manifests are exactly the bytes that land.
- Cons: Every parameter change requires hand-editing the raw manifest. Upgrades = redownload + re-diff. Loses first-class parameterisation. No community example uses this path for ESO. Same reasoning as ADR-0016 Option B.

### Option C — Direct `helm install` from a laptop / CI

- Pros: Familiar Helm workflow.
- Cons: Not GitOps. **Rejected on principle** ([ADR-0015](0015-argocd-app-of-apps-pattern.md)).

### Option D — Vault Secrets Operator (VSO) — replace ESO entirely

HashiCorp ships their own operator (VSO) that reads from Vault into k8s Secrets. Same job as ESO for a Vault-only backend.

- Pros: First-party Vault tooling. Deep Vault integration (auth, PKI, dynamic secrets).
- Cons: **Only handles Vault.** Loses ESO's multi-backend abstraction — meaning switching from Vault (kind) to AWS Secrets Manager (EKS) would require swapping operators, not just SecretStore configs. Also: Phase 4 Crossplane provisions AWS resources whose Secrets we'll want to consume via Secrets Manager; VSO can't do that. **ESO handles both, VSO doesn't.**

## Decision

**Option A — Helm chart via ArgoCD Application, chart pinned to `2.8.0`.**

Same reasoning as ADR-0016. The install path is boring and consistent with cert-manager; the interesting design work (which backend to configure) is deferred to ADR-0020 in Task 2.4.j.

Option D deserves an explicit "no" because it looks tempting from a "pure HashiCorp stack" narrative, but it locks us to Vault forever. ESO's provider-abstraction pays off in Phase 9 when the EKS deploy uses AWS Secrets Manager as the backend for cert-manager's Route53 credentials (via `ClusterSecretStore/aws-secrets-manager`) *and* Vault for something else — one operator, two backends. VSO forces you to two operators for two backends.

## Consequences

- **Positive:** Standard ESO install; every upstream doc, blog post, and Stack Overflow answer applies. Values overrides via `valuesObject` (typed YAML, ArgoCD can diff). Upgrades are one-line changes. Portable across kind and EKS. Consistent pattern with cert-manager, ExternalDNS, AWS LBC.
- **Negative:** ArgoCD renders the chart on its side; debug is one layer deeper (standard for GitOps-with-Helm). No `.keep` equivalent to cert-manager's `crds.keep: true` — deleting the Application via `argocd app delete external-secrets` will cascade CRD deletion. To avoid orphaning downstream ExternalSecret objects, we'd delete those first (or add a `syncOptions: [PruneLast=true]` refinement later).
- **Neutral:** ESO chart version and app image version are separate concepts (chart `2.8.0` ships with app `v2.8.0`). Cognitive overhead vs cert-manager's synced-version scheme is minor once you know.

## When to revisit

- **If we adopt Vault as the *only* backend across all environments.** Then Option D (VSO) becomes worth considering — but this is unlikely given the AWS-native trajectory of Phase 9.
- **If ESO releases a native Kubernetes Operator (OLM) install.** Same argument as ADR-0016 — follow the community if the recommended path shifts.
- **If we need to enable Prometheus scraping.** Add `serviceMonitor.enabled: true` to `valuesObject`. Handled in Phase 3.
- **If EKS Phase 9 needs IRSA annotations on the ESO ServiceAccount.** Add `serviceAccount.annotations` to `valuesObject`. Handled in Phase 9.

## Related decisions

- [ADR-0015](0015-argocd-app-of-apps-pattern.md) — the deployment pattern this Application slots into.
- [ADR-0016](0016-cert-manager-install-via-helm.md) — parent decision on Helm-via-ArgoCD for platform operators; this ADR follows the same shape.
- [ADR-0019](0019-vault-install-for-eso-kind-backend.md) — *pending* — how Vault gets installed as the ESO backend on kind. Written when we ship Task 2.4.g.
- [ADR-0020](0020-eso-backend-strategy.md) — *pending* — per-environment SecretStore strategy (Vault on kind, AWS Secrets Manager on EKS). Written when we ship Task 2.4.j.

## References

- [ESO — installation via Helm](https://external-secrets.io/latest/introduction/getting-started/)
- [ESO Helm chart values reference](https://artifacthub.io/packages/helm/external-secrets-operator/external-secrets)
- [ESO — providers overview](https://external-secrets.io/latest/provider/aws-secrets-manager/)

## Interview framing

The one-liner: *"We install ESO the same way we install every other platform operator — upstream Helm chart wrapped in an ArgoCD Application, pinned to a specific chart version. The install decision is deliberately boring and pattern-consistent. The interesting design work for ESO is which backend to configure — and that's a per-environment call (Vault on local kind, AWS Secrets Manager on EKS via IRSA), documented separately in ADR-0020."*
