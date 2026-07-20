# 0014 — Install ArgoCD from the raw pinned manifest, not the Helm chart

- **Status:** Accepted
- **Date:** 2026-07-20
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 2 needs a GitOps continuous-delivery engine as its very first in-cluster component — everything else in Phases 2–8 (cert-manager, ExternalDNS, ESO, AWS Load Balancer Controller, observability, Crossplane, Kyverno) is going to be reconciled by it. ArgoCD is the accepted choice (see [ADR-0003](0003-use-crossplane-for-per-service-infra.md) — Crossplane is the *substrate* API, ArgoCD is the *delivery* engine).

The remaining question is *how* to install it. Upstream ships six installation paths, each with different trade-offs. This is the first in-cluster component we install, so the choice sets a tone — and the choice we make locally on kind is *not* automatically the same choice we should make on EKS in Phase 9.

## Decision drivers

1. **Learning maximiser.** This is a portfolio project whose primary output is *the engineer*. An install path that hides how ArgoCD is composed teaches nothing. An install path where every object is inspectable and every RBAC binding is greppable teaches a lot.
2. **Cost of migration.** Whichever install we pick locally, we want to be able to swap for a different install method on EKS *without* losing our `Application`/`AppProject`/`ApplicationSet` definitions. Those are Argo's own CRDs and are portable between install methods.
3. **Reproducibility.** The install must be pinned to a specific version. `stable` (a moving branch) or unversioned Helm chart pulls disqualify anything.
4. **Blast radius on teardown.** For a `kind` cluster that gets rebuilt often, "rip out the install and start over" needs to be a single command with no residue.
5. **Alignment with the ArgoCD docs the user is reading.** ArgoCD's own quickstart uses raw `install.yaml`. Matching the docs during the learning phase reduces cognitive load.

## Options considered

### Option A — Raw `install.yaml` from a pinned tag (chosen)

`kubectl apply -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.4.5/manifests/install.yaml` — one file, 59 objects, cluster-scoped install into `argocd` namespace, single replica of every component.

- Pros: Every object visible with `less`. Every RBAC binding greppable. No abstraction between the manifest and the API server. Fastest to install and destroy. Matches ArgoCD's own quickstart docs. Portable — the `Application` / `AppProject` / `ApplicationSet` CRs we write later are install-method-independent, so swapping to Helm on EKS costs nothing.
- Cons: Non-HA (single replica of everything). No parameterisation — flag tweaks require editing raw YAML and losing edits on upgrade. Manual server-side apply required for the ApplicationSet CRD (see Postscript). Upgrade path is "delete namespace, reapply new tag" or manual `kubectl apply` of the new tag — no rolling upgrade orchestration.

### Option B — `namespace-install.yaml`

Same as A but ArgoCD is restricted to managing only its own namespace.

- Pros: Tightest possible blast radius.
- Cons: Defeats the whole point. We want ArgoCD to reconcile the entire cluster in Phase 2+ (`cert-manager`, `external-secrets-system`, `external-dns`, `monitoring`, `crossplane-system`, etc.). Multi-tenant scenarios in which two teams' ArgoCDs coexist on one cluster are not our world.

### Option C — `ha/install.yaml`

Same components as A, but 3 replicas of the controllers, Redis HA with Sentinel, PDBs, anti-affinity rules.

- Pros: Prod-grade out of the box.
- Cons: Overkill for a single-node kind cluster — the anti-affinity rules keep pods `Pending` because there's only one node. Wastes local resources. Right answer for the EKS demo in Phase 9, wrong answer for local dev.

### Option D — `core-install.yaml`

GitOps engine only — no `argocd-server`, no UI, no API, no dex.

- Pros: Smallest surface if you drive everything through `kubectl` against the CRs directly.
- Cons: No UI. Debugging is 80% of why we want ArgoCD at this stage — losing the UI defeats the exploration/learning value.

### Option E — Helm chart `argo/argo-cd`

The parameterised install. `values.yaml` controls every knob.

- Pros: Idiomatic for prod. Easy upgrades via `helm upgrade`. `values.yaml` becomes config-as-code. Handles the large-CRD annotation issue internally (uses server-side apply under the hood). Integrates naturally with app-of-apps once ArgoCD is up — Argo can even manage its own Helm release.
- Cons: Hides the actual objects behind Helm's templating. Worse first-time learning. Requires managing chart version *and* image tag as separate concerns. The value we want from raw install (visibility) is the value Helm deliberately abstracts away.

### Option F — Argo CD Autopilot

Opinionated CLI that installs ArgoCD *and* sets up the app-of-apps Git layout in one command.

- Pros: Two-minute path from empty cluster to self-managing ArgoCD. Skips both this task (2.2.e) and the follow-up (2.2.f).
- Cons: Hides every mechanic we're learning. Third-party (argoproj-**labs**), lower maturity, smaller community than the core project. It's the "black box" option.

## Decision

**Option A — raw `install.yaml`, cluster-scoped, pinned to `v3.4.5`, applied via `kubectl apply --server-side --force-conflicts`.**

The primary win is **visibility**. Every one of the 59 objects that lands on the cluster is inspectable, greppable, and reasonably understood. That matters enormously right now — it stops being important later, and that's exactly when we should switch to Option E.

Option A's biggest weakness (no parameterisation) doesn't bite yet: we don't need to override any defaults for a local install. The moment we do want to override defaults (e.g., custom `resource.customizations`, custom `argocd-cm` values, non-default replica counts), that's the natural trigger to swap to the Helm chart.

Option A's other weakness (upgrade ergonomics) is bounded on kind: destroy the namespace, reapply the new tag. On EKS, that's not acceptable — but on EKS we're going to be on Option E anyway.

**We accept that this same decision will flip to Option E when we move to EKS in Phase 9.** That's expected, planned, and cheap: our `Application`, `AppProject`, and `ApplicationSet` definitions are Argo's own CRDs — they're portable across install methods with zero rewrites.

## Consequences

- **Positive:** All 59 objects visible in one file. Simplest possible teardown (`kubectl delete namespace argocd && kubectl delete crd applications.argoproj.io ...`). Same manifest works on kind and (with different SSA/replica trade-offs) on EKS. Matches ArgoCD's own quickstart docs — reduces cognitive overhead when reading upstream material. Reproducible across contributors (no chart repo add, no Helm state).
- **Negative:** No knobs. Tweaking any argocd-server flag means editing raw YAML — which is fine until it isn't. No rolling upgrades. Requires the `--server-side --force-conflicts` incantation on every apply due to the ApplicationSet CRD's annotation-size limitation — encoded in the `Makefile` so future contributors don't hit it fresh.
- **Neutral:** The upstream `install.yaml` deploys a single replica of every controller — fine for kind, insufficient for EKS. When we move to EKS we swap to Option E (Helm) with `controller.replicas: 3` and Redis HA — a properly parameterised prod install rather than "raw with hand-edits."

## When to revisit

- **The moment we need to override a default.** As soon as we want to change any flag in `argocd-cmd-params-cm`, add a custom resource customization, run more than one controller replica, or enable server-side TLS with a real cert — we switch to Option E (Helm chart).
- **When we move to EKS (Phase 9).** Definitely swap to Helm at that point regardless. The chart handles HA, redis-ha, PDBs, and version pinning cleanly; managing all that in raw YAML in a prod cluster would be an operational anti-pattern.
- **If Argo CD Autopilot matures.** Argoproj-labs projects sometimes graduate to core. If Autopilot becomes an "argoproj" (not "argoproj-labs") project with a stable API, re-evaluate Option F for cluster bootstraps.

## Related decisions

- [ADR-0003](0003-use-crossplane-for-per-service-infra.md) — Crossplane is the substrate API; ArgoCD is the delivery engine that reconciles Crossplane's XRs from Git.
- [ADR-0005](0005-local-first-development-with-kind.md) — kind is our primary dev environment; the install method here targets that reality.
- [ADR-0010](0010-fargate-only-eks-cluster.md) — Fargate-only EKS constrains what runs on the cluster later; ArgoCD Deployments and the StatefulSet are all Fargate-friendly.

## References

- [ArgoCD — Getting Started (install)](https://argo-cd.readthedocs.io/en/stable/getting_started/)
- [ArgoCD — Server-Side Apply requirement for CRDs](https://argo-cd.readthedocs.io/en/stable/operator-manual/installation/#server-side-apply)
- [Kubernetes — Server-Side Apply GA](https://kubernetes.io/docs/reference/using-api/server-side-apply/)
- [Kubernetes — Annotations size limit (256KB, hardcoded in etcd)](https://kubernetes.io/docs/concepts/overview/working-with-objects/annotations/#syntax-and-character-set)

## Postscript — the SSA gotcha (learned the hard way during Task 2.2.c)

The first `kubectl apply -n argocd -f install.yaml` (client-side apply, the default) failed with:

```text
The CustomResourceDefinition "applicationsets.argoproj.io" is invalid:
metadata.annotations: Too long: may not be more than 262144 bytes
```

**Root cause.** Client-side `kubectl apply` stores the full serialised previous state of every object it touches in a `kubectl.kubernetes.io/last-applied-configuration` annotation. Kubernetes hardcodes a 256KB (262144 byte) cap on any annotation value. The ApplicationSet CRD's OpenAPI schema is larger than that when serialised. So the API server rejected the CRD with an annotation-size error.

**Trap.** `kubectl apply` is not a transaction. It applies objects sequentially; failures are per-object. The failed CRD didn't stop the other 58 objects from applying. Result: partial install (2 CRDs of 3, all Deployments, StatefulSet, RBAC, Services, ConfigMaps, NetworkPolicies), and the applicationset-controller pod crashlooping trying to sync a cache for a Kind that doesn't exist.

**Fix.** `--server-side --force-conflicts` on `kubectl apply`. Server-side apply tracks field ownership via a k8s-native `managedFields` structure on the object itself, not via an annotation, so the 256KB limit doesn't apply. `--force-conflicts` is needed on re-apply because the 58 objects that landed via client-side apply are already managed by `kubectl-client-side-apply`; SSA needs explicit permission to take ownership. Baked into the Makefile:

```bash
kubectl apply --server-side --force-conflicts -n argocd -f <manifest>
```

**Interview framing:** *"ArgoCD's ApplicationSet CRD triggers a well-known client-side-apply annotation-size bug. The fix is server-side apply, which stores field ownership as k8s-native managedFields rather than as a last-applied annotation. Same bug bites you with cert-manager, Istio, and any tool with a large OpenAPI schema CRD — server-side apply is the right default for anything with CRDs, full stop."*

**Also documents the deeper lesson:** `kubectl apply` is not atomic. Always follow a bulk apply with a `kubectl get` verification pass. The exit code hides partial failures.
