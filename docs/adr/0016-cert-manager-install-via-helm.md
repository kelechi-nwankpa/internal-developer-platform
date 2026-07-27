# 0016 — Install cert-manager via the upstream Helm chart, as an ArgoCD Application

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 2 needs automated TLS certificate lifecycle — issuance, renewal, and rotation — as a prerequisite for every service that will eventually be exposed via Ingress (ArgoCD UI in Phase 5, Backstage in Phase 5, observability stack in Phase 3, every user-facing service in Phase 6+). cert-manager is the accepted community standard for this on Kubernetes.

Two orthogonal questions arise for the install:

1. **What packaging?** cert-manager ships as a Helm chart *and* as raw manifests. Which do we use?
2. **What deployment mechanism?** Direct `kubectl apply` / `helm install` from a laptop, or GitOps via ArgoCD?

Task 2.2.f shipped the app-of-apps root — question 2 is essentially answered ("via ArgoCD Application in `platform/argocd/apps/`"), but the choice deserves recording rather than being implicit. Question 1 is a real fork.

## Decision drivers

1. **GitOps-first.** Anything installed by hand defeats the pattern shipped in Task 2.2.f. **Non-negotiable.**
2. **Parameterisation ergonomics.** cert-manager's chart exposes ~30 useful values (image tags, resource requests, CRD install behaviour, prometheus scrape, webhook timeout, DNS-01 solver secrets). We *will* want to tweak some of them over time.
3. **Upgrade path.** How do we go from v1.21.0 to v1.22.0 six months from now?
4. **Blast radius on failure.** If the install goes wrong, how much work is it to unpick?
5. **Portability across clusters.** Same install method should work on kind (local dev) and EKS (Phase 9).
6. **Alignment with community norms.** Every real cert-manager deployment in the wild uses the Jetstack Helm chart. Doing something different needs a reason.

## Options considered

### Option A — Helm chart via ArgoCD Application (chosen)

`platform/argocd/apps/cert-manager.yaml` is an ArgoCD `Application` whose `source` points at `https://charts.jetstack.io`, chart `cert-manager`, revision `v1.21.0`. Values overrides via `helm.valuesObject`.

- Pros: GitOps-native. Standard for cert-manager — matches every real-world install. Parameterisable via `valuesObject`. Upgrades = change one line (`targetRevision: v1.22.0`) + merge to main. Blast radius: `argocd app delete cert-manager` cleans up cleanly. Portable across clusters (same file works on kind and EKS).
- Cons: One extra layer of abstraction (Helm rendered by ArgoCD, not by a human). Debug story is slightly harder — errors surface as ArgoCD sync failures rather than direct `helm install` output. Mitigation: `argocd app get cert-manager --show-operation` shows the exact rendered manifests.

### Option B — Raw manifests via ArgoCD Application

`Application.spec.source.path` points at a directory in this repo containing the cert-manager raw manifests (from `https://github.com/cert-manager/cert-manager/releases/download/v1.21.0/cert-manager.yaml`).

- Pros: No Helm involved — the manifests are exactly the bytes that land. Simpler debug story ("what did ArgoCD apply?" = "the file on disk").
- Cons: Every knob (image tag, resource requests, CRD install control) requires editing the raw manifest by hand. Upgrades require re-downloading + re-diffing the whole file. Lose the parameterisation the Jetstack team ships as a first-class API. Same overall reasoning as ADR-0014 flipping from raw (visibility for learning) to Helm (parameterisation for production).

### Option C — Direct `helm install` from a laptop / CI job

- Pros: Familiar Helm workflow.
- Cons: Not GitOps. Defeats Task 2.2.f. Cluster and git drift immediately. **Rejected on principle.**

### Option D — cert-manager Operator (from OperatorHub / OLM)

An OLM (Operator Lifecycle Manager)-managed install.

- Pros: Managed upgrades via OLM.
- Cons: OLM is not installed on our cluster and doesn't ship with kind. Adopting it just for cert-manager is a large tail wagging a small dog. Adds a whole new controller (OLM itself) with its own opinions. Not idiomatic for anything else we're installing.

### Option E — Multi-source Application (chart + local manifests in one Application)

One Application whose `spec.sources` includes both the Jetstack chart *and* a directory of extra manifests (e.g., ClusterIssuers).

- Pros: Ships the operator and its ClusterIssuers in one atomic unit.
- Cons: Sync ordering. ClusterIssuer manifests reference the ClusterIssuer CRD that comes from the chart — a race. Solvable with sync waves, but adds complexity. Also: ClusterIssuer *configuration* is a different lifecycle from the operator itself (issuer changes shouldn't force the operator to reconcile). Better to separate into two Applications.

## Decision

**Option A — Helm chart via ArgoCD Application.**

Same reasoning as ADR-0014 in reverse: for the tool we're *learning* (ArgoCD itself in Task 2.2), raw manifest visibility wins. For a tool we're *consuming* as a platform component (cert-manager), parameterisation and community-standard ergonomics win. The Jetstack Helm chart is the canonical install path — matching it means every piece of upstream documentation, every community answer, every troubleshooting guide applies directly to us. Betting against that alignment would need a compelling reason we don't have.

The single Application scope is deliberate: this file installs the *operator*. ClusterIssuers arrive in a separate Application (Task 2.3.f — [ADR-0017] pending) because their lifecycle differs — you want to be able to change issuer configuration without cycling the operator.

## Consequences

- **Positive:** Standard cert-manager install; every upstream doc and troubleshooting thread applies. Values overrides via `valuesObject` — typed YAML, ArgoCD can diff them. Upgrades are one-line changes. Portable across kind and EKS (same file). Aligns with the app-of-apps pattern — no manual `helm install` in the platform lifecycle.
- **Negative:** ArgoCD renders the Helm chart on its side of the world, not `helm install` on ours. Debug story is one layer deeper: `argocd app get cert-manager --show-operation` to see what actually got applied. This is standard for GitOps-with-Helm and generally an acceptable trade for the reproducibility.
- **Neutral:** `crds.keep: true` in our values means CRDs survive an uninstall — Certificates in downstream namespaces don't cascade-delete. Safer default; requires a manual `kubectl delete crd ...` if we want a totally clean teardown. Documented in the Application file.

## When to revisit

- **If cert-manager releases a Kubernetes Operator (OLM) that becomes the recommended install path.** Unlikely, but if the community shifts, follow.
- **If we start needing sync waves within cert-manager itself** (e.g., an ordering constraint between operator and a companion controller). Then multi-source (Option E) with wave annotations becomes worth the complexity.
- **If we adopt Kustomize for platform-wide config** (values-file overlays, environment-specific patches). Then a Kustomize wrapper around the Helm chart may be cleaner than direct chart usage — though ArgoCD's Helm rendering is generally sufficient.
- **If Kubernetes v1.36 compatibility bites us.** cert-manager v1.21.0's official tested matrix likely covers 1.29–1.34; our kind cluster is 1.36. If we hit a webhook failure or API deprecation, drop to a v1.20.x patch that explicitly supports 1.36, or wait for a v1.21.x patch that adds it.

## Related decisions

- [ADR-0014](0014-argocd-raw-install-vs-helm.md) — how ArgoCD itself was installed (raw for visibility). This ADR flips the choice for cert-manager (Helm for parameterisation) with explicit reasoning why.
- [ADR-0015](0015-argocd-app-of-apps-pattern.md) — the deployment pattern this Application slots into. `platform/argocd/apps/cert-manager.yaml` is the first real child under root.
- [ADR-0017](0017-cert-manager-issuer-strategy.md) — *pending* — ClusterIssuer strategy (SelfSigned for kind, ACME for EKS). Written when we ship Task 2.3.f.

## References

- [cert-manager — installation via Helm](https://cert-manager.io/docs/installation/helm/)
- [cert-manager Helm chart values reference](https://artifacthub.io/packages/helm/cert-manager/cert-manager)
- [ArgoCD — Helm sources with valuesObject](https://argo-cd.readthedocs.io/en/stable/user-guide/helm/#values-object)

## Interview framing

The one-liner: *"For platform components we're consuming (cert-manager, ExternalDNS, ESO), we install via the upstream Helm chart wrapped in an ArgoCD Application. The chart gives us community-standard parameterisation; ArgoCD gives us GitOps reconciliation. This is the opposite of how we installed ArgoCD itself, where raw manifest visibility was the priority — the trade-off flips once the component is a means, not the object of study."*
