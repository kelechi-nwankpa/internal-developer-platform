# Phase 2 — In-cluster platform components (local kind)

- **Status:** 🔄 In progress
- **Started:** 2026-07-15
- **Target complete:** Phase 2 planned as 5 add-ons on local kind: ArgoCD, cert-manager, ExternalDNS, ESO, AWS Load Balancer Controller
- **AWS spend so far:** $0 (Phase 2 is local-first by design; see [ADR-0005](../adr/0005-local-first-development-with-kind.md))

## Business problem

Phase 1 shipped the AWS *substrate* — VPC, EKS, IAM, KMS, ECR, DNS. But a substrate is not a platform. A raw Kubernetes cluster gives you `Pod`, `Service`, `Deployment`, and nothing else. To take a developer's application from Git commit to live URL, you need at least:

- A way to **continuously reconcile** the cluster state to Git (else every change is a manual `kubectl apply`).
- A way to **issue and rotate TLS certificates** without human intervention (else every service starts with a self-signed cert warning and expires without notice).
- A way to **populate DNS records** from cluster state (else adding a new service means a manual Route53 change every time).
- A way to **materialise application secrets** from a secure store (else secrets end up in Git in cleartext or in ConfigMaps).
- A way to **provision AWS L7 load balancers** from Kubernetes Ingress objects (else exposing a service means clicking around the AWS console).

Phase 2 fills exactly that gap. Every component here is the thing that a developer *doesn't have to think about* — they just write `apiVersion: v1, kind: Service` and the platform handles the rest.

## Target users of this phase

- **Platform engineer (the author).** Needs a reproducible local platform that behaves identically to the eventual EKS deployment — GitOps flows work the same, cert-manager flows work the same, etc.
- **Later-phase consumers.** Phase 4 (Crossplane) writes AWS resources via k8s CRDs; Phase 5 (Backstage) drives Application creation by writing to Git; Phase 6 (golden paths) scaffolds services that expect cert-manager and ExternalDNS to Just Work.
- **Contributors joining fresh.** `make kind-up && make argocd-install` should give a working GitOps engine in under 10 minutes on any laptop with Docker + kubectl + kind installed.
- **Security engineer.** Wants to see that: ArgoCD's admin bootstrap secret is rotated and deleted; cert-manager doesn't issue certs to arbitrary domains; ExternalDNS doesn't own the root Route53 zone; ESO reads specific paths in Secrets Manager, not `*`.

## Business value

- **$0 dev cost.** Everything in Phase 2 runs on the local `kind` cluster. AWS is untouched for the entire phase. Contributors can develop the platform on a laptop over airline Wi-Fi.
- **Fully reproducible.** A single `make` invocation per component installs, verifies, and (if needed) uninstalls each in-cluster piece. No untracked `kubectl apply`s.
- **GitOps from day one.** The instant ArgoCD is bootstrapped in 2.2, everything else installed in Phase 2 is a candidate for GitOps management — no manual reinstalls, no drift.
- **Cluster-agnostic story for interviews.** "Same manifests, kind for dev, EKS for prod, $0 developer onboarding cost" is a stronger narrative than "always-on cloud."

## Architecture — what runs where

```text
LOCAL LAPTOP
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  Docker Desktop                                                │
│    └── kind cluster (name: idp, context: kind-idp)             │
│          └── control-plane node (v1.36.1)                      │
│                ├── kube-system namespace                       │
│                │     ├── coredns, kube-proxy, kindnet, etc.    │
│                │                                               │
│                ├── argocd namespace  ◄─── 2.2 shipped          │
│                │     ├── argocd-server               (Deploy)  │
│                │     ├── argocd-repo-server          (Deploy)  │
│                │     ├── argocd-application-controller  (STS)  │
│                │     ├── argocd-applicationset-controller      │
│                │     ├── argocd-notifications-controller       │
│                │     ├── argocd-dex-server                     │
│                │     └── argocd-redis                          │
│                │                                               │
│                ├── cert-manager namespace   ◄─── 2.3 pending   │
│                ├── external-secrets namespace  ◄─── 2.4        │
│                ├── external-dns namespace   ◄─── 2.5           │
│                └── kube-system (AWS LBC)    ◄─── 2.6           │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

Every arrow above is one sub-task. Every namespace is one component. Every component is one ADR (or one section of an ADR) explaining the choice.

## What's shipped so far

| Sub-task | What | Status | Ships |
|---|---|---|---|
| 2.1 | Local `kind` cluster from `platform/kind/kind-config.yaml` | ✅ | Config committed 2026-07-15 |
| 2.2 | ArgoCD bootstrap via raw pinned manifest, SSA install, admin rotation | ✅ | See detailed log below |
| 2.2.f | App-of-apps root wired — ArgoCD now GitOps-manages itself | ✅ | Shipped 2026-07-21; see Task 2.2.f log below |
| 2.3 | cert-manager | 🔲 pending | — |
| 2.4 | External Secrets Operator (ESO) | 🔲 pending | — |
| 2.5 | ExternalDNS | 🔲 pending | — |
| 2.6 | AWS Load Balancer Controller | 🔲 pending | — |
| 2.7 | ArgoCD app-of-apps root — all Phase 2 components managed by ArgoCD itself | 🔲 pending | see 2.2.f follow-up |
| 2.8 | Runbook: `docs/runbooks/kind-recovery.md` | 🔲 pending | — |
| 2.9 | Phase 2 close-out — full destroy → rebuild recording via `make kind-down && make kind-up && make argocd-install` | 🔲 pending | — |

## Task 2.2 — ArgoCD bootstrap (detailed log)

**Shipped 2026-07-20**, across two study sessions on 2026-07-16 and 2026-07-20.

### What we did

Broken into six sub-tasks:

| # | Step | Notes |
|---|---|---|
| 2.2.a | Chose install flavour: **raw `install.yaml`, cluster-scoped, non-HA.** Rejected Helm chart (hides mechanics), HA install (overkill for single node), core-install (no UI), Autopilot (opaque). ADR-0014 records the reasoning + when to swap for Helm. | |
| 2.2.b | Pinned to **`v3.4.5`** — the current stable tag as of 2026-07-15, 1 week old. Rejected `stable` (a moving branch), `v3.3.12` (doc drift), `v3.5.0-rc2` (pre-release). Pinning to a tag rather than a commit SHA is a small integrity trade-off — noted in the ADR. | |
| 2.2.c | Downloaded manifest, checksummed (sha256 `cdf6758b48…`), inventoried (59 objects: 3 CRDs, 3 ClusterRoles + 3 CRBs, 6 Roles + 6 RBs, 7 SAs, 6 Deployments, 1 StatefulSet, 8 Services, 7 NetworkPolicies, 7 ConfigMaps, 2 Secrets). All three images pinned (`quay.io/argoproj/argocd:v3.4.5`, `ghcr.io/dexidp/dex:v2.45.0`, `public.ecr.aws/docker/library/redis:8.2.3-alpine`) — CLAUDE.md §9 compliant. | Applied. Hit two real issues (see below). |
| 2.2.d | Retrieved bootstrap admin password from `Secret/argocd-initial-admin-secret`, logged in via `argocd` CLI on port-forwarded `https://localhost:8080`, rotated password via `argocd account update-password`, deleted the initial-admin-secret. Verified the secret is gone and current session still works. | |
| 2.2.e | This commit. `Makefile` targets `kind-up`, `kind-down`, `kind-status`, `argocd-install`, `argocd-uninstall`, `argocd-status`, `argocd-password`, `argocd-portforward`. ADR-0014. This log. | |
| 2.2.f | App-of-apps root under `platform/argocd/`. ArgoCD now GitOps-manages itself. See Task 2.2.f log below. | ✅ Shipped 2026-07-21 |

### The two real bugs Task 2.2 threw at us

**1. `kubectl apply` annotation-size limit on the ApplicationSet CRD.** First `kubectl apply -n argocd -f install.yaml` failed with `metadata.annotations: Too long: may not be more than 262144 bytes`. Root cause: client-side apply serialises the full previous object state into `kubectl.kubernetes.io/last-applied-configuration`; ArgoCD's ApplicationSet CRD's OpenAPI schema exceeds Kubernetes' 256KB annotation cap. Fix: `kubectl apply --server-side --force-conflicts` — SSA stores field ownership in a native `managedFields` structure, no annotation limit. Baked into the Makefile so it never bites again. Full write-up in ADR-0014 postscript.

**2. Transient quay.io TLS/DNS flakes on first image pull.** Multiple pods hit `ImagePullBackOff` with `TLS handshake timeout` and `dial tcp: lookup quay.io ... no such host` during the first ~2 minutes. Not a config bug — real network flake. Fixed itself: kubelet's exponential backoff loop retried and pulls succeeded on later attempts. Zero intervention required. Key lesson: **Kubernetes' reconciliation model is a superpower** — dependency chains (redis init container → runtime-generated `argocd-redis` secret → argocd-server / application-controller startup) all unwound automatically. This is the same pattern ArgoCD extends to *your* apps once installed.

### Non-obvious things worth banking

- **`kubectl apply` is not a transaction.** One failed CRD didn't stop the other 58 objects from applying. Result: partial install that *looks* healthy at the pod level but is missing critical pieces (in our case, the ApplicationSet CRD). Always follow a bulk apply with `kubectl get` verification — never trust the exit code alone.
- **`kubectl apply -n <ns>` is a *default*, not an *override*.** If the manifest has an explicit `metadata.namespace` on an object, the `-n` flag is ignored for that object. Only unnamespaced entries in the file fall back to `-n`.
- **The ArgoCD manifest does not create its own namespace.** You must `kubectl create namespace argocd` first. Otherwise every namespaced object fails with `namespaces "argocd" not found`, and again — partial install (CRDs land, everything else doesn't).
- **Bootstrap credentials are meant to be single-use.** `Secret/argocd-initial-admin-secret` is auto-generated on first startup; the correct workflow is log in → rotate → **delete the secret**. Leaving it in etcd is the #1 finding in ArgoCD security audits.
- **The `in-cluster` cluster in `argocd cluster list` is not stored anywhere.** It's a synthetic entry that resolves at runtime via Kubernetes in-cluster config — the SA token + CA cert + `KUBERNETES_SERVICE_HOST` env var that kubelet injects into every pod. Every k8s controller uses this same trick. External clusters are stored as `Secret` objects with label `argocd.argoproj.io/secret-type: cluster`.
- **ArgoCD ships default-deny NetworkPolicies between its own components** — but **kind's default CNI (kindnet) does not enforce NetworkPolicy.** The policies are installed but silently no-op on kind. On EKS with the VPC CNI, they take real effect. Worth remembering when we harden in Phase 8.
- **The `argocd-application-controller` is a StatefulSet, not a Deployment.** Stable pod ordinal identity is required for sharding — replicas compute `myShard = hash(cluster) % replicas == ordinal`, and Deployment's random pod hashes would make ownership unstable across rollouts. Same pattern as Kafka brokers, Zookeeper, etcd.

### PR-style review of what shipped

**Strengths:**

- Every object visible and inspectable — the whole point of Option A.
- Reproducible via `make argocd-install`. Fresh contributor path: `make kind-up && make argocd-install` = working ArgoCD in ~5 minutes.
- Zero `:latest` tags. All three images pinned.
- Bootstrap secret handling matches security best practice.
- SSA gotcha encoded in the Makefile — never bites twice.

**Weaknesses (deferred, not blockers):**

- Single-replica everything. Not HA. Fine for kind; will need `ha/install.yaml` or Helm chart for EKS (see ADR-0014 "when to revisit").
- No TLS story — the argocd-server generates a self-signed cert on first startup. Fine locally with `--insecure` on the CLI and a browser cert-warning click. Phase 5 wires cert-manager + Ingress with proper TLS.
- No SSO. `admin` account is break-glass; day-to-day CLI/UI login would want Dex + OIDC federation to GitHub. Phase 8.
- No notifications. `argocd-notifications-controller` is running but no destinations configured. Phase 8 wires Slack.
- No backup. ArgoCD's state is entirely in its CRs — losing them is "re-apply from Git," which is exactly why app-of-apps (2.2.f) matters.

## Task 2.2.f — App-of-apps root (detailed log)

**Shipped 2026-07-21.**

### What we did

Wired the app-of-apps pattern so ArgoCD manages itself and every future Phase 2+ component via GitOps rather than manual `kubectl apply`.

| Artefact | Purpose |
|---|---|
| `platform/argocd/root-app.yaml` | The one `Application` object that starts the recursion. `syncPolicy.automated.prune: true` + `selfHeal: true` + `CreateNamespace=true` + `ServerSideApply=true`. Points at `platform/argocd/apps/`. |
| `platform/argocd/apps/.gitkeep` | Empty placeholder — Task 2.3+ populates this with real child Applications (cert-manager, ESO, etc.). |
| `platform/argocd/README.md` | Explains the layout + the "add a new component" and "remove a component" workflows for future contributors. |
| `Makefile` target `argocd-bootstrap-root` | The single command that applies root-app once. Everything else after this is GitOps. |
| `ADR-0015` | Records the choice of app-of-apps over ApplicationSet / Helm-of-helms / individual manual apply. |

### What we verified after applying

- `argocd app get root` → `Sync=Synced, Health=Healthy` with zero managed resources. **Exactly matches the quiz prediction** — an empty Git source is a legitimate "desired state is nothing" declaration.
- `argocd app list` → one entry (`root`) in the `default` project.
- `kubectl -n argocd get application root -o yaml` → the finalizer `resources-finalizer.argocd.argoproj.io` is present, meaning ArgoCD will cascade-clean children before root itself is deletable.

### The mental model that carries forward

**Adding a Phase 2 component from here on is a one-file PR.** cert-manager (Task 2.3) will not be `helm install`-ed and it will not be `kubectl apply`-ed. It will be a YAML file added to `platform/argocd/apps/cert-manager.yaml` whose contents are an ArgoCD `Application` pointing at `https://charts.jetstack.io` chart `cert-manager v1.x.y`. Merge to main → ArgoCD's next reconcile creates the Application on the cluster → the Application's own reconcile installs cert-manager. Human effort: one PR. Manual `kubectl` calls: zero.

### Non-obvious things worth banking

- **The one imperative act.** `Application/root` itself is not GitOps-managed — someone has to apply it manually once. We could make it self-referential (root's source path includes `../root-app.yaml`), but that adds a subtle circular dependency: if a bad merge disables ArgoCD's ability to reconcile itself, recovery becomes harder. Keeping root-app "outside the loop" preserves the "always recoverable with one manual apply" property. Documented in ADR-0015 consequences.
- **Empty Git source = Synced, not error.** ArgoCD treats an empty directory as "desired state is zero objects." No error, no scary red status. Enables the exact workflow we want: deploy root-app FIRST, add children over time.
- **Two sync options that turn the pattern into a superpower.** `CreateNamespace=true` on the root's syncPolicy means child Applications don't have to worry about their target namespace existing yet — ArgoCD creates it. `ServerSideApply=true` means large CRDs (cert-manager, Crossplane, Kyverno) apply cleanly without the 256KB annotation gotcha we hit in Task 2.2.c. Both were hard-won lessons from the last two tasks; both are encoded in root-app so we never re-learn them.
- **Prune is the delete-a-file-get-an-uninstall property.** Without `prune: true`, removing a file from `apps/` leaves the deployed resources on the cluster as orphans. With prune, ArgoCD tears them down on next reconcile — but only *its* managed resources, not other things in the same namespace. Safe, contained, reversible.
- **The `default` AppProject is permissive.** For Phase 2 dev this is fine. For prod, we'd want a `platform` AppProject that whitelists only this repo + the platform namespaces. Deferred to Phase 8 hardening.

### PR-style review

**Strengths:**

- One `make argocd-bootstrap-root` and the platform is self-managing.
- Every future component install/uninstall is a one-file PR with full audit history in `git log`.
- Drift-corrects within ~3 minutes on any manual `kubectl edit`.
- Root-app remains recoverable via a single `kubectl apply` — no circular dependency risk.
- SSA + CreateNamespace sync options mean the platform-installation footguns we hit in Task 2.2.c are permanently avoided for every future component.

**Weaknesses (deferred, not blockers):**

- `spec.project: default` is permissive. For prod, a tighter `platform` AppProject that scopes allowed repos and namespaces is the right hygiene. Phase 8.
- `targetRevision: HEAD` means any merge to `main` reconciles immediately. Fine for solo dev with a protected `main`; for a team, per-environment branches (`main` → dev, `staging` → staging, `production` → prod) with different root-apps per env is the standard pattern. Phase 9 EKS install will introduce that.
- Root-app is `apps-list-lives-in-a-single-directory` — flat structure. Will not scale past ~20 hand-crafted Applications without a naming convention or subdirectory reorganisation. Trigger to revisit noted in ADR-0015.
- No status notification wired — if root-app or a child fails to sync, no one gets paged. Phase 8 wires `argocd-notifications-controller` to Slack.

## ADRs written this phase (so far)

| # | Decision | Why interesting for portfolio |
|---|---|---|
| [ADR-0014](../adr/0014-argocd-raw-install-vs-helm.md) | Install ArgoCD from the raw pinned manifest, not the Helm chart | Documents the SSA annotation-size lesson; ties option choice to learning value + planned migration to Helm on EKS |
| [ADR-0015](../adr/0015-argocd-app-of-apps-pattern.md) | Use the ArgoCD app-of-apps pattern for platform bootstrap | Documents the bootstrap paradox and its resolution; explains how app-of-apps and ApplicationSet coexist in later phases |

## What's next

- **2.2.f** (follow-up commit, before 2.3) — app-of-apps root under `platform/argocd/`. `root-app.yaml` points ArgoCD at `platform/argocd/apps/` in this repo. ArgoCD reconciles itself from Git going forward. Every future Phase 2 component (cert-manager, ESO, ExternalDNS, AWS LBC) becomes an `Application` in that directory, not a manual `helm install`.
- **2.3** — cert-manager. Installed by an ArgoCD `Application` (not by hand). Configured for staging Let's Encrypt initially, production only when we hit real domains.
- **2.4–2.6** — ESO, ExternalDNS, AWS LBC, in that order. Each one installed as an ArgoCD `Application`.

## Interview talking points (running list, will grow)

- *"Why raw manifest and not Helm for ArgoCD?"* — see ADR-0014 decision drivers. Punchline: "For local learning, visibility beats parameterisation. For prod on EKS, the trade-off flips. The decision to swap is a one-line ADR revision."
- *"Walk me through what happens if `kubectl apply` half-succeeds."* — see the partial-install experience with the ApplicationSet CRD. Key lesson: apply is not a transaction; always verify with `kubectl get` after bulk operations.
- *"How does ArgoCD authenticate to the cluster it lives on?"* — in-cluster config: SA token + CA cert + env vars injected by kubelet. Same primitive every k8s controller uses. Extra clusters need stored kubeconfigs (as Secrets in the argocd namespace).
- *"Why is the application-controller a StatefulSet?"* — stable pod ordinal identity for sharding. Deployments would give random pod hashes, breaking `myShard = hash(cluster) % replicas == ordinal` across rollouts.
