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
│                ├── cert-manager namespace   ◄─── 2.3 shipped   │
│                ├── external-secrets namespace  ◄─── 2.4 shipped│
│                ├── vault namespace          ◄─── 2.4 shipped   │
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
| 2.3 | cert-manager (operator + SelfSigned ClusterIssuer, end-to-end proven) | ✅ | Shipped 2026-07-28; see Task 2.3 log below |
| 2.4 | External Secrets Operator (ESO) + HashiCorp Vault (kind backend) + ClusterSecretStore + end-to-end proven + root token rotated | ✅ | Shipped 2026-08-01; see Task 2.4 log below |
| 2.5 | ExternalDNS | 🔲 pending | — |
| 2.6 | AWS Load Balancer Controller | 🔲 pending | — |
| 2.7 | ArgoCD app-of-apps root — all Phase 2 components managed by ArgoCD itself | 🔄 in progress | 6 Applications live: cert-manager, cert-manager-issuers, external-secrets, external-secrets-stores, vault, vault-config. ExternalDNS + AWS LBC still to come. |
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

## Task 2.3 — cert-manager (detailed log)

**Shipped 2026-07-28**, across three study sessions (2026-07-27 → 2026-07-28). First component installed by pure GitOps — no manual `kubectl apply` for any platform config change.

### What we did

Seven sub-tasks:

| # | Step | Notes |
|---|---|---|
| 2.3.a | Chose install source (**Helm chart via ArgoCD Application** — the operator is a *consumed* component, so parameterisation beats visibility, opposite of ADR-0014's choice for ArgoCD itself) + initial ClusterIssuer type (**SelfSigned** — zero external deps for kind, exercises the entire wiring without needing DNS or ACME). | Both choices recorded in ADR-0016 + ADR-0017. |
| 2.3.b | Pinned **`v1.21.0`** — current stable tag (released 2026-07-08, ~3 weeks old). Rejected `v1.20.3` (n-1, doc drift) and `v1.19.6` (n-2, more drift). Chart version = app version for the Jetstack chart, so one pin covers both. | Same doc-drift reasoning as Task 2.2.b. Flagged that k8s v1.36.1 is outside cert-manager's officially tested matrix — didn't bite in practice. |
| 2.3.c | Drafted `platform/argocd/apps/cert-manager.yaml` — ArgoCD Application, `charts.jetstack.io` chart `cert-manager` v1.21.0, sync policy mirrors root (automated prune + selfHeal + CreateNamespace + ServerSideApply), values overrides: `crds.enabled: true` + `crds.keep: true` (safety default so downstream Certificate objects survive Application removal). Everything else = chart defaults. | Deliberately minimal — chart defaults are sensible; no cargo-culted resource limits. |
| 2.3.d | Drafted ADR-0016 (install-via-Helm-via-ArgoCD-Application). Explicitly flips ADR-0014's raw-manifest reasoning with the "learning vs consumption" distinction. | Sets the pattern for every subsequent platform component (ESO, ExternalDNS, AWS LBC). |
| 2.3.e | Commit `09214ba` + push. **First real GitOps deploy.** Force-synced root (`argocd app sync root`). Within seconds: cert-manager Application appeared, Helm chart rendered, 6 CRDs installed, 3 Deployments (`cert-manager`, `cert-manager-webhook`, `cert-manager-cainjector`) Running, all 3 pods Ready with zero restarts. | Zero manual `kubectl` from a laptop. Zero `helm install`. |
| 2.3.f | Drafted `platform/cert-manager/clusterissuers.yaml` (SelfSigned active + LE-staging/LE-prod as commented templates for Phase 9 EKS activation) + `cert-manager-issuers.yaml` (wrapping Application) + ADR-0017 (per-environment issuer strategy). Commit `d5e9571` + push. ClusterIssuer landed with `Ready: True` in <5 seconds. Then manual end-to-end test: `kubectl apply` a test Certificate → cert-manager issued a real X.509 cert (2048-bit RSA, 90-day validity, CN=`test.idp.seniormankelz.dev`) into a `Secret/test-selfsigned-tls` (type `kubernetes.io/tls`, keys: `ca.crt` + `tls.crt` + `tls.key`) → cleaned up. | Test Certificate deliberately NOT in git — verification is manual, platform config is GitOps. |
| 2.3.f-fix | Fixed root Application permanent `OutOfSync` caused by `directory.recurse: false` being stripped by k8s `omitempty` serialization. Removed the field from both `cert-manager-issuers.yaml` and `root-app.yaml`; added inline comments explaining the pattern so no one reintroduces it. Commit `432add0` + push. All three Applications now Synced/Healthy. | See "the real bug" and ADR-0015 postscript. |
| 2.3.g | This commit — phase log update + ADR-0015 postscript + close-out recap. | |

### The real bug — `directory.recurse: false` and Kubernetes omitempty

After Task 2.3.f, `argocd app list` showed:

```text
argocd/cert-manager           Synced     Healthy
argocd/cert-manager-issuers   Synced     Healthy
argocd/root                   OutOfSync  Healthy   ← wouldn't clear
```

Force-syncing root reported "successfully synced" but the OutOfSync status persisted. Every `argocd app diff root` returned the same delta:

```text
===== argoproj.io/Application argocd/cert-manager-issuers ======
>     directory:
>       recurse: false
```

Root's target state (from git) declared `directory: { recurse: false }`; the live Application on the cluster had no `directory` field at all. Since they didn't match, drift was reported. Since ArgoCD couldn't make them match (writing `false` didn't help — the field got stripped again), the drift was **permanent**.

**Root cause.** The ArgoCD Application CRD's Go type declares:

```go
type ApplicationSourceDirectory struct {
  Recurse bool `json:"recurse,omitempty"`
}
```

`omitempty` on a Go `bool` means: on serialization, drop the field if it equals the Go zero value (`false`). So when we sent `recurse: false` to the API server, the server accepted it, stored it, and on every subsequent read serialized it back with the field absent. Git had the field; cluster didn't. Diff reported it. Sync couldn't fix it.

**Fix.** Remove the field entirely. `recurse: false` is already the default, so omitting it changes nothing behaviourally; it only stops the phantom drift. Fixed in commit `432add0`.

**Why this matters beyond ArgoCD.** The pattern — *"explicit zero value + `omitempty` = permanent GitOps drift"* — bites any tool that compares declared vs live state on Kubernetes resources. Terraform hits it. Pulumi hits it. Crossplane Compositions will hit it in Phase 4 when we start writing bool fields. The lesson is universal: **if a boolean is `false` and its CRD marks the field `omitempty`, don't set it explicitly — omit it and let the default apply.** Setting `true` is safe (`true` isn't the zero value, so it survives round-tripping); setting `false` is a trap.

Documented as a postscript on ADR-0015 for permanent-reference indexing.

### Non-obvious things worth banking

- **The two-layer indirection genuinely works.** Push a file to `platform/argocd/apps/`, root reconciles, creates the child Application, child reconciles, applies its own manifests. All within ~5 seconds on kind (limited by ArgoCD's polling frequency and Helm rendering time).
- **`crds.enabled: true` + `crds.keep: true` is the right cert-manager Helm default.** Enable so CRDs are installed; keep so uninstalling cert-manager doesn't cascade-delete every Certificate in every downstream namespace. Safer than the alternative even though it means a manual `kubectl delete crd ...` for a truly-clean teardown.
- **SelfSigned isn't a toy issuer.** The X.509 cert produced has a real serial number, real 2048-bit RSA key material, real 90-day validity window, and real renewal scheduling. Every code path cert-manager exercises for LE-staging or LE-prod is exercised for SelfSigned too — just with a different signature source. Great for local proving-out.
- **Test Certificate as manual `kubectl apply` — not in git.** Platform config = GitOps; verification tests = ad-hoc kubectl. Different tools for different concerns. Keeps `platform/argocd/apps/` free of noise.
- **Commented-out YAML for future-environment issuers.** Ships the LE-staging + LE-prod templates now, activated by uncomment + placeholder fill in Phase 9. Migration from kind → EKS = 2-line change, not rewriting the manifests.
- **HTTP-01 is impossible for us.** `.dev` is HSTS-preloaded; browsers refuse plain HTTP even for the ACME challenge. DNS-01 is mandatory. That constraint set Phase 1's DNS work (Route53 subdomain delegation) up perfectly.
- **`argocd app sync <name> --force` doesn't fix `omitempty` drift.** The apply succeeds, the field gets stripped again, drift returns. The fix is at the source (remove the field from the manifest), not at the sync layer.

### PR-style review

**Strengths:**

- First GitOps deploy delivered on the app-of-apps promise perfectly — 3 pods running, 6 CRDs installed, 0 manual kubectl.
- Operator install and issuer config as separate Applications — different lifecycles, upgrades don't cross-contaminate.
- LE issuers ship as commented templates — Phase 9 activation is uncomment + fill, not rewrite.
- End-to-end proven with real X.509 cert issuance in <5 seconds.
- The `omitempty` gotcha caught + fixed + documented as an ADR postscript — future contributors have permanent institutional knowledge.

**Weaknesses (deferred, not blockers):**

- Still `spec.project: default` on both cert-manager Applications. Tighter `platform` AppProject that whitelists exactly this repo + these namespaces is Phase 8 hardening.
- No `syncOptions: [PruneLast=true]` — if we ever delete cert-manager, the CRDs might get pruned before the operator itself, leaving downstream Certificate objects in an orphaned state. Not a live concern; nice discipline for Phase 8.
- Test Certificate flow is manual. Automating it as a health check (e.g., a cronjob that issues + verifies + deletes a test cert nightly) would give us a canary. Deferred.
- Kubernetes v1.36.1 compatibility with cert-manager v1.21.0 is unofficial. Didn't bite; if it does in the future, the fix is a chart-version bump or a k8s downgrade — both cheap.

## Task 2.4 — External Secrets Operator + Vault (detailed log)

**Shipped 2026-08-01**, across 6+ study sessions (2026-07-27 → 2026-08-01). The heaviest task of Phase 2 by wall-clock and by depth — bundled ESO install, a whole Vault install with the manual-unseal ceremony, ESO/Vault integration via k8s auth method, the root token rotation drill, and one real "the recovery flow actually happens" moment when a laptop reboot re-sealed Vault mid-session.

### What we did

Fourteen sub-tasks:

| # | Step | Notes |
|---|---|---|
| 2.4.a | Chose install source (**Helm chart via ArgoCD Application** — same reasoning as ADR-0016 for cert-manager) + backend for kind (**local HashiCorp Vault** over Fake provider or LocalStack — deepest portfolio value, teaches Vault as a bonus component). | ADR-0018 + ADR-0019 record both. |
| 2.4.b | Pinned **ESO chart `2.8.0`** — current stable (~9 days old). Same doc-alignment reasoning as Task 2.2.b + 2.3.b. | Chart version and app image tag are separate concepts for ESO (`v2.8.0` app, `2.8.0` chart); worth naming. |
| 2.4.c | Drafted `platform/argocd/apps/external-secrets.yaml` — minimal Application, chart defaults accepted, `valuesObject: {}`. | ADR-0018 documents the reasoning + explicitly rules out Vault Secrets Operator (VSO) because it can't handle AWS Secrets Manager on EKS. |
| 2.4.d | Commit `623d165` + push. All 3 ESO pods Running, ~25 CRDs installed (much richer than cert-manager's 6 — ESO has generators for GitHub tokens, ECR auth, STS sessions, Vault dynamic secrets, and more). ESO operator installed idle, waiting for its first `SecretStore`. | |
| 2.4.e | Decided **Vault install mode: standalone + manual unseal.** Rejected dev mode (hides all interesting Vault ops), auto-unseal (skips the ceremony we specifically wanted to learn), HA mode (overkill for single-node kind). | ADR-0019 records the reasoning + auto-unseal migration path. |
| 2.4.f | Pinned **Vault chart `0.34.0`** + accept default app image (chart internally pins to `v2.0.3`). | Vault v2.x uses BSL license — portfolio-safe (only "competing hosted Vault-as-a-service" is restricted); interview readiness noted in ADR-0019. |
| 2.4.g | Drafted `platform/argocd/apps/vault.yaml` — ~130 lines with explanatory comments. Standalone HCL config, 1Gi PVC, UI on port 8200, injector + CSI explicitly DISABLED (both redundant with ESO — one operator, not three, to get secrets into pods). | ADR-0019 documents mode + auto-unseal migration path + BSL note. |
| 2.4.h | Commit `46da5d6` + push. Vault Application `Synced/Progressing`; pod came up **`Running 0/1` because sealed** (expected). Ran the ceremony: `vault operator init` (saved 5 unseal keys + root token to password manager) → `vault operator unseal` × 3 → `Sealed: false`. Then enabled k8s auth method: created `ClusterRoleBinding/vault-tokenreview-binding` (imperatively for immediacy, moved to git in 2.4.j), `vault auth enable kubernetes`, `vault write auth/kubernetes/config`. | The **educational moment** — every real Vault deployment starts sealed and needs this exact ceremony. |
| 2.4.i | Enabled KV v2 engine at `secret/`, wrote `eso-reader` policy (`path "secret/data/*" { capabilities = ["read"] }`), created k8s auth role binding `external-secrets/external-secrets` SA → `eso-reader` policy (1h TTL), seeded a test secret. Manually simulated exactly what ESO would do: got an ESO SA token, sent to Vault `/v1/auth/kubernetes/login`, received a Vault token, read the test secret. **Write blocked with 403** — least-privilege verified. | Proves the auth chain end-to-end before writing any GitOps YAML. |
| 2.4.j | Drafted `platform/vault/clusterrolebinding-tokenreview.yaml` (moves imperative CRB to git) + `platform/argocd/apps/vault-config.yaml` (wrapping Application) + `platform/external-secrets/clustersecretstore-vault.yaml` (the actual ClusterSecretStore) + `platform/argocd/apps/external-secrets-stores.yaml` (wrapping Application) + ADR-0020 (per-env backend strategy). | Pattern now consistent across cert-manager, ESO, and Vault: operator Application + config Application, split by lifecycle. |
| 2.4.k | Commit `f28e79f` + push. Forced root refresh via `kubectl annotate application root argocd.argoproj.io/refresh=hard` (argocd CLI JWT had expired — kubectl doesn't have that issue). Both new Applications appeared Synced/Healthy within 90s. `ClusterSecretStore/vault-kv` reported **`Status: Valid, Ready: True, "store validated"`** — ESO successfully exercised the full auth chain on its own. CRB adopted by ArgoCD (field managers list shows both `argocd-controller` and legacy `kubectl-create` — SSA historical retention, harmless). | |
| 2.4.l | **End-to-end test through the full GitOps loop.** `kubectl apply ExternalSecret/test-from-vault` in `default` namespace → ESO synced within <1s → `Secret/test-from-vault` materialised with exact values from Vault (`username=demo-user, password=hello-from-vault-2026`). Deleted the ExternalSecret → cascade cleanup → back to zero state. | The whole ESO promise realised: developer declares, backend delivers, k8s Secret appears. |
| 2.4.m | **Root token rotation ceremony** — `vault operator generate-root -init` → OTP + nonce → provide 3 unseal keys → encoded token → decode with OTP → new root. Failed the ceremony 3 times before succeeding (OTP/encoded-token mismatch class of error — well-known Vault gotcha). Verified new root works, revoked the old one. | The old root had accidentally leaked into chat via `vault token lookup` output earlier; rotation eliminated that exposure. Also happened to hit a real "laptop rebooted, Vault sealed" recovery in the middle of this task — exactly the friction ADR-0019 predicted. |
| 2.4.n | This commit. Phase log update + memory update. | |

### The real bugs Task 2.4 threw at us

**1. Root token leaked in chat via `vault token lookup` output.** During Task 2.4.i verification, I ran `kubectl -n vault exec vault-0 -- vault token lookup` to confirm the pod's cached token was working. Vault's default `token lookup` output **prints the token ID**, which landed in our chat transcript. Same class of issue as the ArgoCD admin password episode from Task 2.2.d. Fix: **`vault token capabilities <path>` or `vault kv list <path>` for auth verification** — either fails cleanly if unauth'd without exposing the token. Also motivated the rotation ceremony (2.4.m) which invalidated the exposed token.

**2. The Vault rotation ceremony is genuinely fiddly.** `vault operator generate-root` splits across four commands: `-init` (generates OTP + nonce), 3 × `-nonce=<X>` (provide unseal keys, get encoded token), `-decode=<encoded> -otp=<otp>` (reveals new root token). Common failure mode: OTP from attempt N used to decode encoded_token from attempt N+1 → produces a plausible-looking-but-invalid token string, which then fails `vault login` with 403. Hit this 3 times before succeeding. Fix: **treat OTP + encoded_token as a bound pair from the same operation, save both to a scratch file the moment they're generated, never re-run `-init` between them.** HashiCorp's own docs call out this class of user error.

**3. Manual unseal drill actually happened.** Laptop reboot mid-session → Vault pod restarted → sealed. Everything blocked (rotation command returned `503 Vault is sealed`). Exactly what ADR-0019 predicted as the "cons" of manual unseal. Recovery: 3× `vault operator unseal` with keys from password manager, ~30s. This is the recurring cost we chose over auto-unseal for the training value; it's the "recovery drill" that ADR-0019 says is precisely the point.

**4. ArgoCD CLI JWT expiring across sessions.** Recurring since Task 2.2. Every ~24h the CLI session expires and needs `argocd login`. Kubectl doesn't have this — kubelet auth via client cert is durable. Workaround this session: force root reconcile via `kubectl annotate application root argocd.argoproj.io/refresh=hard --overwrite` instead of `argocd app sync`. **Permanent fix: SSO via Dex + GitHub OIDC (Phase 8).** Would refresh the session automatically off the identity provider.

**5. SSA field manager coexistence on the CRB.** After ArgoCD adopted the imperative `vault-tokenreview-binding` via SSA, `kubectl get clusterrolebinding vault-tokenreview-binding -o jsonpath='{.metadata.managedFields[*].manager}'` showed **both** `argocd-controller` AND `kubectl-create`. SSA retains field ownership history per manager. Not a conflict (the two managers' declared states agreed at adoption time), but a visible artefact. **Real-world cleanup:** `kubectl patch --field-manager=kubectl-create --subresource=metadata --type=merge --patch '{"metadata":{"managedFields":[]}}'` to reset. Not worth doing for us; historical entry is harmless.

### Non-obvious things worth banking

- **Shamir's Secret Sharing is more than a slogan.** Vault splits its master key into 5 shares with threshold 3 by default. You can lose 2 keys and still unseal; an attacker needs 3 to compromise. In real deployments the 5 keys go to 5 different humans in different geographies — no single person can unseal alone. We ran the ceremony ourselves; the pattern is now real intuition, not textbook trivia.
- **Vault starts sealed on every restart.** Not a bug — an intentional security property. Sealed Vault has zero decryption capability; even a compromised pod filesystem leaks no secrets (they're encrypted at rest with the master key that's in memory only). This is what makes "manual unseal drill" a real security practice, not just ceremony.
- **ESO's provider abstraction is the whole reason we chose ESO over VSO.** Same `ExternalSecret` shape works with Vault (kind), AWS Secrets Manager (EKS), GCP Secret Manager, Azure Key Vault, 1Password, Doppler. Workloads never see the backend. On EKS in Phase 9 we swap `secretStoreRef.name: vault-kv` → `secretStoreRef.name: aws-secrets-manager` per-workload — zero rewrite. VSO would force us to switch operators for that.
- **Vault k8s auth requires `system:auth-delegator` on Vault's SA.** So Vault can call `TokenReview` on the API server to validate incoming SA tokens. Without this ClusterRoleBinding, every ESO auth attempt fails with "permission denied." Now committed as `platform/vault/clusterrolebinding-tokenreview.yaml` so cluster rebuilds recreate it via GitOps.
- **KV v2 splits data and metadata paths.** Policy for a KV v2 engine at mount `secret/` needs `path "secret/data/*"` for read access (not `secret/*`) — the `/data/` prefix is where actual values live. `secret/metadata/*` is versioning/deletion metadata. ESO handles the prefix internally when `version: v2` is set. Confusing at first; well-documented once you know.
- **Vault CLI is not installed on your laptop.** All `vault` commands go via `kubectl exec` into the pod. Alternative: `brew install vault` + port-forward + local CLI for shorter command lines. Not worth it for our frequency of use.
- **`vault operator generate-root` produces a plausible-looking string when OTP+encoded mismatch.** It doesn't error — it produces garbage that decodes to what looks like a token but authenticates to nothing. Diagnostic: try `vault login <new-token>` and expect either success or 403. Never revoke the old until the new is verified working.
- **`kubectl exec -it vault-0` alone does nothing.** You need `-- sh` for a shell or `-- vault <command>` for a specific command. Common trip-up for anyone new to kubectl.

### PR-style review

**Strengths:**

- ESO + Vault fully GitOps-managed. Six ArgoCD Applications under root (cert-manager, cert-manager-issuers, external-secrets, external-secrets-stores, vault, vault-config), all Synced/Healthy.
- Full auth chain proven end-to-end: workload SA → JWT → Vault k8s auth → Vault token bound to eso-reader policy → read from `secret/data/*` → materialised k8s Secret → developer consumes as env/volume.
- Pattern consistent across all three platform components: operator install (Helm chart) + config Application (raw manifests in this repo). Applies uniformly to cert-manager, external-secrets, vault.
- Vault install decisions all documented across ADR-0018, ADR-0019, ADR-0020 with explicit reasoning + when-to-revisit triggers.
- Root token rotated after initial exposure — clean audit-trail cutover.
- Manual unseal drill practiced under real recovery pressure (laptop reboot mid-session), exactly the muscle memory ADR-0019 predicted this would build.

**Weaknesses (deferred, not blockers):**

- Still `spec.project: default` on all Applications. Tighter `platform` AppProject that whitelists exactly this repo + these namespaces is Phase 8 hardening.
- Vault runs as a single replica with no auto-unseal — a Vault pod restart requires manual re-unseal before ESO can read anything. Fine for local dev; wrong shape for anything user-facing. On EKS we don't run Vault at all (AWS Secrets Manager instead).
- Vault UI has no TLS (`tls_disable = 1` in the standalone config). Phase 5 cert-manager + Ingress could give it a real cert if we needed external UI access; not required for our workflow (port-forward + localhost).
- SSA field manager coexistence on the CRB (`argocd-controller` + `kubectl-create`). Harmless artefact but visible. Fixable with a manual `kubectl patch` if it ever matters.
- Vault's internal state (auth methods, policies, roles, secrets) is NOT managed by GitOps — configured via manual `vault write` commands documented in this log. A real prod deployment would use the Terraform Vault provider. For portfolio value, the manual commands are more educational.

## ADRs written this phase (so far)

| # | Decision | Why interesting for portfolio |
|---|---|---|
| [ADR-0014](../adr/0014-argocd-raw-install-vs-helm.md) | Install ArgoCD from the raw pinned manifest, not the Helm chart | Documents the SSA annotation-size lesson; ties option choice to learning value + planned migration to Helm on EKS |
| [ADR-0015](../adr/0015-argocd-app-of-apps-pattern.md) | Use the ArgoCD app-of-apps pattern for platform bootstrap | Documents the bootstrap paradox and its resolution; explains how app-of-apps and ApplicationSet coexist in later phases. Postscript on the `directory.recurse: false` omitempty drift trap. |
| [ADR-0016](../adr/0016-cert-manager-install-via-helm.md) | Install cert-manager via the upstream Helm chart, as an ArgoCD Application | Explicitly flips ADR-0014's raw-manifest choice — visibility for learning vs parameterisation for consumption. Sets the pattern every subsequent platform component follows. |
| [ADR-0017](../adr/0017-cert-manager-issuer-strategy.md) | ClusterIssuer strategy: SelfSigned on kind, Let's Encrypt on EKS | Per-environment issuer matrix; explains why DNS-01 over HTTP-01 (`.dev` HSTS-preloaded, wildcard cert requirement); LE issuers as commented templates for Phase 9. |
| [ADR-0018](../adr/0018-external-secrets-install-via-helm.md) | Install External Secrets Operator (ESO) via the upstream Helm chart, as an ArgoCD Application | Explicit "same pattern as cert-manager" ADR — records the choice + explicitly rules out Vault Secrets Operator (VSO) because it can't handle AWS Secrets Manager which Phase 9 needs. |
| [ADR-0019](../adr/0019-vault-install-for-eso-kind-backend.md) | Install HashiCorp Vault (standalone + manual unseal) as the ESO backend on kind | Documents 5 install-mode options weighed with the auto-unseal migration path noted. Includes BSL licensing note for interview readiness. |
| [ADR-0020](../adr/0020-eso-backend-strategy.md) | ESO backend strategy: Vault on kind, AWS Secrets Manager on EKS | Per-env backend matrix with same `ExternalSecret` shape working on both. Cross-refs ADR-0008 (KMS) + ADR-0009 (IRSA) as Phase 1 dependencies for the EKS side. |

## What's next

- **2.5 — ExternalDNS.** Auto-populates Route53 records from Ingress annotations. Idle on kind (nothing routable), meaningful on EKS. Same Application pattern.
- **2.6 — AWS Load Balancer Controller.** ALB provisioning from Ingress objects. Only relevant on EKS; installed but idle on kind. Together with 2.5 completes the "declare an Ingress, get a public HTTPS URL" story we've been building toward.
- **2.7 — status update after 2.5/2.6 land** — will mark app-of-apps as fully populated.
- **2.8 — `docs/runbooks/kind-recovery.md`** — the "kind cluster died, what do I do?" runbook. Covers `make kind-down && make kind-up && make argocd-install && make argocd-bootstrap-root` + Vault re-init + unseal + reseed test-secret + expected reconcile time.
- **2.9 — Phase 2 close-out recording.** Full destroy-rebuild demo, top-to-bottom, on video. The portfolio finale for Phase 2.

## Interview talking points (running list, will grow)

- *"Why raw manifest for ArgoCD but Helm chart for cert-manager?"* — visibility for the *tool we're learning* (ArgoCD in Task 2.2 — inspect every RBAC binding, understand every controller); parameterisation for *tools we're consuming* (cert-manager in Task 2.3 — chart defaults are sensible, values.yaml handles the ~5 knobs we care about). Same underlying pattern (GitOps via ArgoCD Application); different source type per the calculus.
- *"How does GitOps handle the 'delete a file' case?"* — `syncPolicy.automated.prune: true` on the parent Application. Root sees the file gone, ArgoCD prunes the child Application, the child's own finalizer cascades to its managed resources. One PR removal = full component uninstall + cleanup.
- *"Walk me through what happens if `kubectl apply` half-succeeds."* — the ApplicationSet CRD partial-install story from Task 2.2.c. Server-side apply fixes the annotation-size class of failure; the general lesson is that apply isn't atomic — always verify with `kubectl get` after bulk operations.
- *"How does ArgoCD authenticate to the cluster it lives on?"* — in-cluster config: SA token + CA cert + env vars injected by kubelet. Same primitive every k8s controller uses. Extra clusters need stored kubeconfigs (as Secrets in the argocd namespace).
- *"Why is the application-controller a StatefulSet?"* — stable pod ordinal identity for sharding. Deployments would give random pod hashes, breaking `myShard = hash(cluster) % replicas == ordinal` across rollouts.
- *"What's `directory.recurse: false` doing in your Application YAML?"* — trick question. It's NOT there anymore; can't be. K8s strips omitempty bool fields when they equal the zero value, so setting `false` explicitly causes permanent GitOps drift between git (present) and cluster (stripped). Real bug we hit. Same class of issue bites Terraform, Pulumi, Crossplane. Documented as ADR-0015 postscript.
- *"Why SelfSigned issuer for kind, not Let's Encrypt staging?"* — zero external dependencies (offline dev works), zero LE quota consumed on dev churn, exercises exactly the same wiring (Certificate → CertificateRequest → cert bytes → Secret) as any other issuer. Wrong choice for prod; right choice for local. When we hit EKS, we uncomment the LE-staging + LE-prod ClusterIssuers already sitting in the same file as commented templates.
- *"Why ESO over Vault Secrets Operator (VSO)?"* — VSO only handles Vault. ESO handles Vault (kind), AWS Secrets Manager (EKS via IRSA), GCP Secret Manager, Azure Key Vault, and many others with the same `ExternalSecret` API. Multi-backend clusters (Vault for internal secrets + Secrets Manager for AWS-managed ones) need ESO. If you're single-backend and it's Vault, VSO wins on deep integration; if you might ever be multi-backend, ESO is the right abstraction.
- *"Walk me through Vault's manual unseal ceremony."* — Vault splits its master key via Shamir into 5 shares with threshold 3. Every restart starts sealed. Three unseal keys → master key reconstructed in memory → data decryptable. Auto-unseal delegates this to KMS (AWS/GCP) or another Vault (Transit). We deliberately picked manual on kind to practice the ceremony that most operators only run once in prod and then forget.
- *"How does Vault's Kubernetes auth method work?"* — Vault needs `system:auth-delegator` on its own SA so it can call `TokenReview` on kube-apiserver. Workload presents its own SA JWT; Vault validates via TokenReview; if valid + matching a role's `bound_service_account_names`, Vault issues a scoped-policy token. No static credentials between workloads and Vault; the same mechanism secures ESO's access.
- *"What's the difference between Vault's KV v1 and KV v2?"* — v2 adds versioning + soft-delete. Also splits the path: data at `secret/data/*`, metadata at `secret/metadata/*`. Policies must reference the split paths (`path "secret/data/*"` for read). ESO handles the prefix internally when configured with `version: v2`. Confusing at first; well-documented.
- *"Tell me about a time you rotated Vault's root token."* — Ran `vault operator generate-root -init` → OTP + nonce → provided 3 unseal keys → encoded token → decoded with OTP → verified new root worked → revoked old. Failed the ceremony 3 times on OTP/encoded-token mismatch before succeeding. HashiCorp calls out this class of user error in their docs; getting it right requires treating OTP + encoded_token as a bound pair from the same `-init` operation.
