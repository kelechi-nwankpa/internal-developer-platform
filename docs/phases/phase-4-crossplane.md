# Phase 4 — Crossplane (Kubernetes-native infrastructure API)

- **Status:** ✅ Shipped (core scope: ObjectBucket XRD end-to-end validated)
- **Started:** 2026-08-05
- **Finished:** 2026-08-07
- **Duration:** 3 calendar days, ~4-5 focused sessions + significant troubleshooting
- **Total AWS spend:** **$0** (Phase 4 is local-first; MRs deliberately don't reconcile without ProviderConfig — activation is Phase 9)
- **Scope note:** ObjectBucket XRD shipped in full (design + Composition + end-to-end validated via in-cluster apply). Second XRD (Namespace, PostgresDatabase, ManagedSecret) and ProviderConfig for real AWS reconciliation deliberately deferred — see "What's next."

## Business problem

Phases 1-3 built the *platform* — infrastructure + observability + operators. Phase 4 makes it consumable as a **developer-facing API**. Instead of asking the platform team for "an S3 bucket, a Postgres DB, an IAM role" (2-day ticket queue), a developer writes a Kubernetes CR (`kind: ObjectBucket, spec: {region: eu-west-1, publicRead: false}`) and Crossplane materialises the whole thing.

This is the substrate every Phase 5 golden path is built on. Backstage's "click a button, get a service" flow is at the bottom just YAML files driving Crossplane XRs.

## Target users of this phase

- **Platform engineer (author).** Defines XRDs (developer-facing API) + Compositions (recipe). One-time work per abstraction; every downstream consumer benefits.
- **App engineers (Phase 6+).** Consume the XRDs via YAML in their manifests. Never touch AWS console. Never write Terraform.
- **Security engineers.** RBAC on XR creation. IRSA scoping on providers. Every provisioning event auditable via Kubernetes events + audit logs.
- **On-call.** "Why isn't the DB up?" answered via `kubectl describe postgresdatabase my-app-db` — same debug flow as any k8s workload.

## Business value

- **The "2 days → 10 minutes" story crystallises here.** Backstage in Phase 5 will render an XRC when a developer clicks "New service." XRC materialises real AWS resources (on EKS). Done.
- **Continuous reconciliation of infrastructure.** Delete an S3 bucket via console → Crossplane recreates it on next reconcile (state drift auto-corrected).
- **API-as-a-product.** Our XRDs *are* the developer-facing product. Versioned, documented (via ADRs), migrated over time — same discipline as any REST API.

## Architecture — what actually runs now

```text
                CLUSTER
    ┌──────────────────────────────────────────────────────────┐
    │                                                          │
    │  crossplane-system namespace                             │
    │   ├── crossplane (core operator)                         │
    │   ├── crossplane-rbac-manager                            │
    │   ├── provider-family-aws (base)                         │
    │   ├── provider-aws-s3     (30+ MR CRDs)                  │
    │   ├── provider-aws-iam    (20+ MR CRDs)                  │
    │   ├── function-go-templating  (Composition rendering)    │
    │   └── function-auto-ready     (XR status rollup)         │
    │                                                          │
    │  CLUSTER-SCOPED (our platform's developer-facing API)    │
    │   └── XRD: xobjectbuckets.platform.idp.io v1alpha1       │
    │        ├── XR kind: XObjectBucket                        │
    │        └── XRC kind: ObjectBucket (namespace-scoped)     │
    │                                                          │
    │   └── Composition: xobjectbuckets.platform.idp.io        │
    │        (Pipeline: fn-go-templating → fn-auto-ready)      │
    │                                                          │
    │  ~230 CRDs total (was ~40 pre-Phase-4)                   │
    │                                                          │
    │  On kind: MRs exist but don't reconcile (no ProviderConfig) │
    │  Phase 9 EKS: IRSA-authed ProviderConfig → real AWS      │
    │                                                          │
    └──────────────────────────────────────────────────────────┘
```

## What's shipped

| Task | Component | Status | Notes |
|---|---|---|---|
| 4.1 | Strategic intro + 4 design decisions confirmed (v1 track, family+s3+iam providers, ObjectBucket first, skip ProviderConfig on kind) | ✅ | |
| 4.2 | Crossplane core installed (chart 1.20.11) | ✅ | Commit `81b14b6`. ADR-0026. |
| 4.3 | 3 AWS providers installed (family + s3 + iam v2.6.0) via Provider CRs | ✅ | Commit `6959bd5`. 50 AWS CRDs. |
| 4.4.a-b | Design confirmed + fn-go-templating + fn-auto-ready Functions installed | ✅ | Commit `9092e30`. |
| 4.4.c-d | ObjectBucket XRD + Composition drafted, deployed via GitOps | ✅ | Commit `8144d43`. ADR-0027. |
| 4.4.e | Composition validated end-to-end via in-cluster apply | ✅ | 4 MRs materialised, external-name generated (`my-app-uploads-34945a`) |
| 4.6 | Second XRD (Namespace) | 🔲 deferred | Phase 6 prep or dedicated sub-task |
| 4.7 | This close-out | ✅ | |

## Task 4.4 — ObjectBucket XRD (detailed log)

**Shipped 2026-08-07** across ~2 focused sessions after Phase 4 troubleshooting cleared.

### What we did

Five sub-tasks:

| # | Step | Notes |
|---|---|---|
| 4.4.a | Confirmed all 4 design decisions from Phase 4 intro: minimal 3-field API (region/publicRead/versioning), 4 conditionally-rendered MRs with secure defaults, `<claim>-<6char-uid-suffix>` bucket naming, modern Pipeline mode with fn-go-templating + fn-auto-ready | Recorded in ADR-0027. |
| 4.4.b | Installed 2 Function packages: `function-go-templating v0.12.3` + `function-auto-ready v0.7.0`. Added to `platform/crossplane/functions.yaml` — same directory as providers, so the existing `crossplane-providers` Application picks them up automatically. | Commit `9092e30`. |
| 4.4.c | Drafted the XRD (`xobjectbuckets.platform.idp.io v1alpha1`) with `spec.parameters` (region enum, publicRead bool, versioning bool) + status fields (bucketName, bucketArn). Drafted the Composition using fn-go-templating Pipeline mode: 4 conditionally-rendered MRs. | ADR-0027. |
| 4.4.d | Commit `8144d43` + push. Refreshed root Application → children reconciled → XRD `ESTABLISHED=True, OFFERED=True`, Composition bound to `XObjectBucket v1alpha1`. Both auto-generated CRDs (`xobjectbuckets.platform.idp.io` + `objectbuckets.platform.idp.io`) appeared. | |
| 4.4.e | Pivoted from `crossplane render` (Docker timeouts on function pod spawn) to **in-cluster validation**: `kubectl apply` the XR, watch Crossplane reconcile through the Composition, `kubectl get` the resulting MRs. All 4 MRs materialised: `Bucket/my-app-uploads`, `BucketPublicAccessBlock/my-app-uploads-pab`, `BucketVersioning/my-app-uploads-versioning`, `BucketServerSideEncryptionConfiguration/my-app-uploads-sse`. External-name generated: `my-app-uploads-34945a` (UID-derived suffix worked). Cleaned up with cascade delete. | This is a stronger validation than `crossplane render` — proves the whole controller flow works. |

### The Composition Pipeline pattern (worth banking)

Modern Crossplane Composition is a **pipeline of Functions**, not a monolithic patch-and-transform. Ours has 2 steps:

1. **`function-go-templating`** — Go template renders MRs from XR field values. Sprig functions available (`randAlphaNum`, `substr`, `replace`, `default`, etc.). Full conditionals + loops.
2. **`function-auto-ready`** — inspects composed MR conditions, rolls up Ready:True to the XR when all MRs are Ready.

Each Function runs as its own pod. Pipeline mode replaces legacy patch-and-transform (removed in v2.x per ADR-0026).

### The 4 non-obvious Composition idioms (captured in ADR-0027)

- **Stable-suffix bucket naming from XR UID** — prevents re-render churn. Anti-pattern: bare `randAlphaNum` (regenerates every reconcile → provider tries delete-recreate → chaos).
- **Conditional rendering with `{{- if ... }}` / `{{- end }}`** — trailing dash strips whitespace so no blank lines emit when condition is false.
- **`composition-resource-name` annotation** — every MR needs this or fn-go-templating errors out. Slot names must be unique per Composition; used by fn-auto-ready to correlate status.
- **`crossplane.io/external-name` annotation** — separates k8s object name from cloud-side name. S3 bucket names are globally unique across AWS; k8s object names only within a namespace. Two names, one annotation.

## The real bugs Phase 4 threw at us

This phase had a substantial troubleshooting cascade after landing 50+ new CRDs from Task 4.3. Five distinct issues surfaced, each worth banking:

### 1. metrics-server CrashLoopBackOff after CRD injection

**Symptom:** `kubectl top nodes` returned `error: Metrics API not available`. metrics-server pod had 11 restarts over ~8h.

**Root cause:** metrics-server scrapes kubelet's `/metrics/resource` endpoint at 10s timeout. After Task 4.3's 50 CRD injection, kubelet was busy re-listing CRDs + rebuilding informers → slow to respond → scrape timed out → livez probe failed → pod restarted → same issue in a loop.

**Fix:** kick the pod (`kubectl delete pod -n kube-system -l app.kubernetes.io/name=metrics-server`). Fresh pod after the CRD-injection cascade settled → succeeded on first probe. Long-term prevention: `--kubelet-request-timeout=20s` values override on the metrics-server Application.

### 2. Docker Desktop VM memory ceiling at 86%

**Symptom:** After metrics-server came back, `kubectl top nodes` showed **86% memory usage** on the kind VM. Everything cluster-wide was flaky — ArgoCD UI slow, apiserver restarting.

**Root cause:** Docker Desktop VM defaults to ~4 GiB memory. We'd stacked ~2.9 GiB of platform pods (ArgoCD + observability + Crossplane + all providers + Phase 2 operators). Zero headroom.

**Fix:** Docker Desktop → Settings → Resources → Memory slider → bumped from ~4 GiB to 8 GiB. Apply & Restart. Cluster survives (kind uses named Docker volumes). After bump: CPU 8%, memory 5.94 GiB (~70% of 8 GiB).

**Runbook implication:** the [kind-recovery runbook](../runbooks/kind-recovery.md) already covers "cluster died, rebuild" but didn't yet mention "Docker Desktop memory constrained." Worth adding as prerequisite verification in Failure Mode 4.

### 3. Vault sealed after Docker Desktop restart

**Symptom:** After Docker Desktop restart (from memory bump), the `external-secrets-stores` Application flipped to Degraded. Vault Application showed Progressing.

**Root cause:** Docker Desktop's "Apply & Restart" restarts every kind pod. **Vault comes back SEALED per ADR-0019** (standalone mode + manual unseal is the deliberate trade-off). ESO can't authenticate against sealed Vault → ClusterSecretStore validation fails.

**Fix:** Straight from the runbook Failure Mode 1: `kubectl -n vault exec -it vault-0 -- vault operator unseal` × 3 with unseal keys from password manager.

**This is the third time this session-cascade played out** (Task 2.4.h original, Task 3 memory issue, Phase 4 Docker bump). The runbook is EARNING its keep.

### 4. ESO stuck on exponential backoff after Vault unsealed

**Symptom:** Unsealed Vault, waited 1+ minute, external-secrets-stores Application still Degraded. ESO's ClusterSecretStore/vault-kv stuck `Ready: False, reason: InvalidProviderConfig`.

**Root cause:** ESO's reconciler had backed off after several auth failures during the sealed period. controller-runtime's exponential backoff can reach 5-10 min after enough failures. Next retry was scheduled well after Vault was unsealed — but not soon enough for us to see recovery.

**Fix:** kick the ESO pod (`kubectl -n external-secrets delete pod -l app.kubernetes.io/name=external-secrets`). Fresh pod = fresh backoff timer = immediate retry attempt = success.

**Runbook improvement (patched):** [kind-recovery.md Failure Mode 1 now includes ESO-backoff kick](../runbooks/kind-recovery.md). Future me at 3am won't wait 10 min unnecessarily.

### 5. kube-prometheus-stack Grafana admin-password drift loop

**Symptom:** `kube-prometheus-stack` Application shows `OutOfSync/Healthy`. `argocd app diff` shows drift on 2 resources: `Secret/kube-prometheus-stack-grafana` (data.admin-password field) + `Deployment/kube-prometheus-stack-grafana` (`checksum/secret` annotation that follows the Secret). Every reconcile the drift comes back.

**Root cause:** Grafana chart auto-generates admin-password on every render (its "if empty auto-generate" logic). After Task 3.3.d we rotated the password via `grafana cli admin reset-admin-password` and deleted the field for hygiene. Chart's next render sees the field empty → generates a new random value → ArgoCD sees drift → syncs → deletes it → chart generates again on next render → infinite cycle.

**Fix:** `spec.ignoreDifferences` on the ArgoCD Application for the specific field paths (Secret's `/data/admin-password` + Deployment's `checksum/secret` annotation). Grafana keeps working (authenticates against DB with rotated password, ignores Secret). Commit `df76bfb`.

**Two big lessons from this fix:**

- **Refresh root vs child matters.** `ignoreDifferences` lives in the child Application's spec. Root reconciles git → updates child spec. Refreshing the child alone won't pick up the new ignoreDifferences — you have to refresh root FIRST, wait for it to propagate, then refresh child.
- **"Sync error" vs "OutOfSync" are different signals.** Sync error is historical (last SYNC OPERATION failed). Refresh only updates OutOfSync/Synced. To clear a stale Sync error you need a successful sync operation.

**Runbook improvement (patched):** [kind-recovery.md Failure Mode 5 documents this whole pattern](../runbooks/kind-recovery.md) — chart-generated Secret drift after post-install rotation. Applies to Grafana today, likely bites us again with Alertmanager receivers or Loki auth in future phases.

### Meta-lesson from the cascade

**One heavy CRD injection (Task 4.3's 50 CRDs) triggered 5 distinct downstream failures over ~4h.** None of them were "Crossplane bugs" — they were all resource pressure cascades (metrics-server timeout, VM memory ceiling, pod restarts, backoff timers, chart-generated drift resurfacing). Root cause was Docker Desktop's default memory allocation being too small for our accumulated platform.

**Preventable next time:** bump Docker Desktop memory to 8 GiB *before* installing new operators, not after. Added to memory as a Phase 4 lesson.

## Non-obvious things worth banking

- **Crossplane on kind installs but doesn't reconcile MRs.** Deliberate per ADR-0026 — no ProviderConfig on kind. Validation via in-cluster apply proves the Composition + rendering works; real AWS reconciliation waits for Phase 9.
- **`crossplane render` needs Docker + can hang.** In-cluster apply is a better validation path when the cluster has Function pods already running. Function pods are warm; local Docker spawn is slow.
- **Crossplane's package manager pulls OCI images** for both Providers and Functions. Same registry (`xpkg.upbound.io/crossplane-contrib/`). Similar Provider CR / Function CR shapes.
- **Chart version vs app version is finally consistent for Crossplane** — chart 1.20.11 = app 1.20.11. Not the case for ESO, Vault, ExternalDNS.
- **Provider CRs go through Installed → Healthy states.** Installed = OCI package pulled + CRDs unpacked. Healthy = controller pod Ready. Both need to be True before MRs will reconcile.
- **fn-auto-ready must be paired with a rendering function.** Without it, XRs stay perpetually NotReady even when all MRs are Ready — no automatic status rollup.
- **The "learn, document, don't re-derive" pattern is real ROI.** The runbook has been patched twice in this phase alone (FM1 addendum, new FM5). Every future encounter with these failure modes is a 5-minute fix instead of a 1-hour debug session.

## PR-style review

**Strengths:**

- ObjectBucket XRD + Composition ships as a real developer-facing API. Validated end-to-end via in-cluster apply (better than dry-run `crossplane render`).
- 4 non-obvious Composition idioms captured in ADR-0027 for future XRDs.
- 5 real bugs debugged + 2 runbook patches. Portfolio-visible institutional knowledge.
- Chart-native pattern (Providers + Functions as OCI packages managed via CR) — matches upstream idioms.
- Kind vs EKS migration path clear (no ProviderConfig on kind → IRSA ProviderConfig on EKS is a values-only change to a future config Application).

**Weaknesses (deferred, not blockers):**

- Only 1 XRD shipped. Real platform will need PostgresDatabase, ManagedSecret, Namespace at minimum. Deferred.
- No provider-kubernetes installed (needed for Namespace XRD in future Task 4.6). Deferred.
- MRs never actually reconcile on kind — visual/functional demo requires Phase 9 EKS.
- Composition template is inline in the YAML (large string). At scale, extracting to separate `.tmpl` files would be more maintainable. Not worth it for 1 XRD.
- Docker Desktop memory management became a real bottleneck — future phases (Loki, Tempo, more Crossplane XRDs) will need continued memory bumps or a switch to a more resource-efficient local k8s (k3d, MicroK8s). Noted for Phase 8 hardening.

## ADRs written this phase

| # | Decision | Why interesting for portfolio |
|---|---|---|
| [ADR-0026](../adr/0026-crossplane-install-and-version.md) | Install Crossplane core (chart 1.20.11, v1 track) as ArgoCD Application | v1-over-v2 decision with ecosystem-maturity reasoning; migration to v2 is Phase 8+ concern. |
| [ADR-0027](../adr/0027-first-xrd-objectbucket.md) | First XRD (ObjectBucket): API surface, Composition pattern, naming | 4 sub-decisions weighed. "Composition patterns to remember" section captures 4 non-obvious idioms (stable-suffix naming, conditional rendering, composition-resource-name annotation, external-name annotation). |

## Deferred sub-tasks (pick up when appropriate)

- **Task 4.6** — Second XRD (Namespace) via `provider-kubernetes`. Contrast with ObjectBucket (no cloud API involvement, just k8s objects). Own sub-task or Phase 5 prep.
- **PostgresDatabase XRD** — requires `provider-aws-rds`. Phase 6 or Phase 4.5.
- **ManagedSecret XRD** — Crossplane wrapper around ESO's ExternalSecret. Cross-operator glue; Phase 6 or later.
- **ProviderConfig with IRSA** — Phase 9 EKS activation. Manifests templated in ADR-0022 style (commented until Phase 9).
- **`crossplane render` in CI** — dry-run Composition validation before merge. Phase 6+ development-workflow polish.

## What's next — Phase 5

**Phase 5 — Backstage (the developer portal).** The click-a-button UI that consumes our XRDs. A developer visits Backstage, picks "New microservice," fills a form; Backstage generates a GitHub repo, applies a `ObjectBucket` XRC to their team's namespace, creates the DNS entry via the ExternalDNS + cert-manager chain from Phases 2-3.

Phase 5 = Phase 4's XRDs + Phase 2-3's infrastructure = one-click developer experience.

Session opener for Phase 5: *"start Phase 5, Backstage developer portal."*

## Interview talking points

- *"How is your platform's developer-facing API defined?"* — Crossplane XRDs (Composite Resource Definitions). We define shape (fields + validation), Crossplane generates the k8s CRDs, and a Composition renders raw cloud resources (Managed Resources) from user-provided field values. Developers write `ObjectBucket` YAML; behind the scenes it becomes an S3 Bucket + PublicAccessBlock + Versioning + SSE — none of which they touch.
- *"Why Crossplane v1 not v2?"* — Ecosystem maturity. Every provider is v1-first; community answers assume v1. v2 has a cleaner mental model but the migration cost is real. Migration to v2 is Phase 8+ concern once the provider ecosystem catches up.
- *"How do Crossplane Compositions render MRs from an XR?"* — Modern approach is Pipeline mode with Functions. fn-go-templating for Go-template rendering + fn-auto-ready for status rollup. Legacy patch-and-transform is being removed in v2.x. Compositions can chain any Functions in any order — very flexible.
- *"Tell me about a subtle bug in Composition templates."* — Bucket naming with bare `randAlphaNum` regenerates on every reconcile → provider tries delete-recreate → chaos. Fix: derive suffix from XR UID (`substr 0 6 ($uid | replace "-" "")`) — stable across reconciles.
- *"How do you validate a Composition without cloud access?"* — Two options: (1) `crossplane render` for dry-run outside cluster (needs Docker + OCI pulls, can hang); (2) apply the XR to a cluster with providers installed but no ProviderConfig — MRs materialise as k8s objects but don't reconcile against cloud. We use option 2 on kind; it exercises more of the real flow.
- *"How does ArgoCD refresh cascade through app-of-apps?"* — Refresh root re-reads git → updates child Application specs. Refresh child re-diffs child's downstream resources against git. Two-hop model: git change to a child's spec needs root refresh first, then child refresh. Learned during Grafana ignoreDifferences fix.
- *"Docker Desktop memory ceiling under Crossplane."* — Kind cluster + platform accumulated to 86% of 4 GiB VM. Cascading pod restarts, metrics-server timeouts. Fix: bump Docker Desktop VM memory to 8 GiB. Real-world platform engineering considerations — local dev environments have real resource limits.
