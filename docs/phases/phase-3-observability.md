# Phase 3 — Observability

- **Status:** ✅ Wave 1 shipped (2026-08-05) + ✅ Wave 2 shipped (2026-09-08)
- **Wave 1 (metrics):** kube-prometheus-stack + metrics-server + ServiceMonitors — single-day compressed phase
- **Wave 2 (logs + traces):** Loki distributed + Grafana Alloy + Tempo distributed + OTel Collector + MinIO storage — ~4 focused sessions across ~4 weeks calendar time
- **Total AWS spend:** **$0** (all kind, both waves)
- **Full observability triangle live:** metrics (Prometheus) + logs (Loki) + traces (Tempo), cross-linked in Grafana per ADR-0030's drill-down design.

---

## Wave 1 — Metrics (kube-prometheus-stack + metrics-server)

- **Status:** ✅ Shipped 2026-08-05 (single-day compressed phase)
- **Scope note:** metrics stack shipped in full. Logs + traces followed in Wave 2 below.

## Business problem

Phase 2 built a platform. Phase 3 makes it **inspectable**. Every operator we installed exposes Prometheus metrics; nothing was scraping them. Every pod logs to stdout; nothing was collecting. Any workload we'd add in Phase 4+ would run blind.

Building observability *before* workloads is deliberate ([CLAUDE.md §4](../../CLAUDE.md)): *"Debugging is only cheap when it's already built."*

## Target users of this phase

- **Platform engineer (author).** Needs dashboards + metric queries for every operator installed in Phase 2. First real per-operator visibility.
- **App engineers (Phase 6+).** Will inherit a running observability stack for their own metrics + dashboards.
- **On-call (Phase 8+).** Will inherit an Alertmanager wired to Slack/PagerDuty.
- **Security engineers.** Will inherit audit-log queryability (once Loki lands).

## Business value

- **Zero-to-observability in one day.** From nothing to a full Prometheus + Grafana stack scraping every Phase 2 operator, all via GitOps.
- **~180 pre-built Kubernetes dashboards.** Chart bundle payoff. Nodes, pods, workload, apiserver, kubelet, cAdvisor — all working from the moment kube-prometheus-stack is Synced.
- **`kubectl top` works.** Basic operational tool restored.
- **Every operator's health queryable via PromQL.** Foundation for future dashboards, alerts, SLOs.

## Architecture — what actually runs now

```text
                CLUSTER
    ┌──────────────────────────────────────────────────────────┐
    │                                                          │
    │  monitoring namespace (~10 pods)                         │
    │   ├── prometheus-kube-prometheus-stack-prometheus-0      │
    │   │    (Prometheus, 24h retention, 2Gi PVC)              │
    │   ├── alertmanager-kube-prometheus-stack-alertmanager-0  │
    │   │    (Alertmanager, 1Gi PVC, routing deferred to P8)   │
    │   ├── kube-prometheus-stack-grafana-*                    │
    │   │    (Grafana + sidecars, 1Gi PVC, admin rotated)      │
    │   ├── kube-prometheus-stack-operator-*                   │
    │   │    (prometheus-operator — manages the 3 above)       │
    │   ├── kube-prometheus-stack-kube-state-metrics-*         │
    │   │    (k8s object state → Prometheus metrics)           │
    │   └── kube-prometheus-stack-prometheus-node-exporter-*   │
    │        (OS-level metrics, DaemonSet)                     │
    │                                                          │
    │  kube-system namespace                                   │
    │   └── metrics-server-*                                   │
    │        (kubectl top + HPA — DIFFERENT from Prometheus)   │
    │                                                          │
    │  ServiceMonitors (Task 3.5) — 10 hand-rolled + chart:    │
    │   ├── argocd/         → 5 SMs (hand-rolled, ADR-0025)    │
    │   ├── cert-manager/   → 3 SMs (from chart)               │
    │   ├── external-secrets/ → 3 SMs (from chart)             │
    │   └── external-dns/   → 1 SM (from chart)                │
    │                                                          │
    │  Prometheus scraping: 23 UP targets across the cluster   │
    │                                                          │
    └──────────────────────────────────────────────────────────┘
```

## What's shipped

| Task | Component | Status | Notes |
|---|---|---|---|
| 3.1 | Strategic intro + design decisions confirmed (bundle over à la carte, metrics before logs/traces, PVC-backed 24h retention) | ✅ | |
| 3.2 | metrics-server (Kubernetes Metrics API — kubectl top + HPA) | ✅ | Shipped 2026-08-05; commit `f4a4d4d` |
| 3.3 | kube-prometheus-stack (Prometheus + Grafana + Alertmanager + operator + kube-state-metrics + node-exporter + ~180 dashboards) | ✅ | Shipped 2026-08-05; commit `899109a`. Grafana admin rotated via `grafana cli admin reset-admin-password` (see Task 3.3 log). |
| 3.5 | ServiceMonitors for Phase 2 operators (hybrid: chart values where supported + hand-rolled for ArgoCD) | ✅ | Shipped 2026-08-05; commits `73c8faf` + `ec49c6f` (selector-filter fix) |
| 3.5.h | Vault ServiceMonitor + telemetry config | 🔲 deferred | Vault needs telemetry HCL stanza + `unauthenticated_metrics_access = true` — security trade-off worth its own investigation. Own sub-task. |
| 3.6 | Curated dashboards for Phase 2 operators | 🔲 deferred | Chart's ~180 built-in dashboards give plenty of visibility. Custom dashboards are portfolio polish. |
| 3.7 | Alertmanager routing (Slack/PagerDuty destinations) | 🔲 deferred to Phase 8 | Alertmanager is installed and healthy; no destinations wired. |
| 3.8 | Phase log close-out + ADR-0024 postscript on selector-filter trap | ✅ this commit | |

## The real bugs Phase 3 threw at us

### 1. Grafana admin password Secret ↔ DB drift (Task 3.3)

Grafana chart auto-generates an admin password on install, writes it to `Secret/kube-prometheus-stack-grafana` at key `admin-password`. But **login with that password failed** with `password-auth.invalid`.

Root cause: chart uses an env-var-from-Secret pattern to seed Grafana's DB on first startup. If the Grafana container starts before the sidecar populates the env var, Grafana initialises its DB with a different password than what's now in the Secret. The Secret has the "correct" random string; the DB has something else. Login fails against the Secret's value.

**Fix:** bypass the Secret entirely by directly resetting the DB password via `grafana cli admin reset-admin-password` (invoked via `kubectl exec` into the Grafana pod). Wrote the new password to the DB directly. Login worked. Deleted the stale `admin-password` field from the Secret post-rotation for hygiene.

**Key sub-lesson: the unified `grafana` binary vs old `grafana-cli`.** Modern Grafana images (11.x+) ship a single `grafana` binary with subcommands (`grafana cli admin ...`). Older images had a separate `grafana-cli`. First `kubectl exec ... grafana-cli` returned "executable file not found" — we `sh -c "which grafana grafana-cli"` to find the actual path (`/usr/share/grafana/bin/grafana`) and rewrote the command.

### 2. Prometheus not scraping our ServiceMonitors (Task 3.5)

After Task 3.5's initial commit, all 10 ServiceMonitors deployed successfully (visible via `kubectl get servicemonitor -A`) — but Prometheus wasn't scraping any of them. Target count stayed at 14 (kube-prometheus-stack's own SMs), not the expected 24+.

Root cause: **kube-prometheus-stack's Prometheus CR has `serviceMonitorSelector: {matchLabels: {release: kube-prometheus-stack}}` by default.** This filters discovered SMs to only those labelled with `release=kube-prometheus-stack`. Chart-created SMs automatically get this label; SMs from sub-charts (cert-manager, ESO, ExternalDNS) and hand-rolled SMs (ArgoCD) do NOT — silently ignored.

**Fix:** four values-overrides on the Prometheus CR spec:

```yaml
prometheus:
  prometheusSpec:
    serviceMonitorSelectorNilUsesHelmValues: false
    podMonitorSelectorNilUsesHelmValues: false
    probeSelectorNilUsesHelmValues: false
    ruleSelectorNilUsesHelmValues: false
```

Setting these tells the chart: "when the user leaves the selector empty, keep it truly empty (match all) instead of auto-injecting a `release=<name>` filter." Committed in `ec49c6f`. Immediately after, Prometheus discovered all 10 new SMs and target count jumped to 27 (23 UP + 4 kind-inherent DOWN).

This is a well-known kube-prometheus-stack trap — "prometheus not scraping servicemonitor" turns up dozens of Stack Overflow hits. **Postscript added to ADR-0024** so future contributors find the fix by grep.

### 3. Wrong metric names in the "verify it works" tour

Task 3.5's celebration message included a list of PromQL queries to run in Grafana Explore to prove each operator was being scraped. Two of the metric names were guessed based on convention rather than checked against reality:

- `certmanager_certificate_ready_status` — doesn't exist. Actual: `certmanager_clusterissuer_ready_status` (per-issuer readiness) or `certmanager_clock_time_seconds` (basic liveness).
- `externalsecret_status_condition` — doesn't exist. Actual: `externalsecret_provider_api_calls_count` or `controller_runtime_reconcile_total`.

Fixed by grepping the actual metric names from `/api/v1/label/__name__/values`. Reference list of "is-it-healthy?" queries per operator now in the ADR-0025 references section.

Small teaching moment: **don't ship a metric name from convention without checking the actual endpoint.** `kubectl exec` into the operator pod + `curl :port/metrics` (or query Prometheus's metric-names API) gives the ground truth in 30s.

## Non-obvious things worth banking

- **metrics-server and Prometheus are complementary, not competing.** metrics-server for kubectl top + HPA (basic CPU/memory, ~1min retention); Prometheus for rich observability with history. Both needed.
- **kind kubelets use self-signed certs** — metrics-server needs `--kubelet-insecure-tls` on kind. Don't set on EKS.
- **Chart-native ServiceMonitors > hand-rolled** where the chart supports them (ADR-0025). Chart bumps handle port/label/path changes; hand-rolled ones freeze.
- **The kube-prometheus-stack chart's default selector filter is a trap.** Set `*SelectorNilUsesHelmValues: false` in prometheusSpec if you want SMs from other namespaces/charts to be discovered.
- **Vault's `/v1/sys/metrics` needs auth or `unauthenticated_metrics_access = true`** in Vault HCL config. Deferred to its own sub-task with the security trade-off documented.
- **Grafana's admin password can drift between Secret and DB** at first install. Reset via `grafana cli admin reset-admin-password` inside the pod as the guaranteed-works path.
- **Modern Grafana ships one `grafana` binary** with subcommands, not a separate `grafana-cli`. `sh -c "which grafana grafana-cli"` for image-agnostic discovery.
- **Kind doesn't expose kube-controller-manager, kube-etcd, kube-proxy, kube-scheduler** on the standard ports. Those 4 targets always show DOWN on kind. Cosmetic; not indicative of a real problem.
- **`argocd_app_info` returns N series where N = number of ArgoCD Applications.** Beautiful proof that ArgoCD reports the entire platform inventory as metrics — one series per Application.

## PR-style review

**Strengths:**

- Full metrics stack shipped in one focused day.
- Every Phase 2 operator now scraped via ServiceMonitors — 23 UP targets, real data queryable in Grafana Explore.
- Hybrid ServiceMonitor strategy documented (ADR-0025) — chart-native where supported, hand-rolled where necessary.
- Two real bugs hit and documented (Grafana password drift, Prometheus selector filter) — permanent institutional knowledge in ADR postscripts + this phase log.
- Chart-recommended dashboards (~180) work out of the box. Zero custom-dashboard work needed to demonstrate the platform.
- Complementary to metrics-server: kubectl top + HPA restored.

**Weaknesses (deferred, not blockers):**

- Vault's metrics still not scraped — pending 3.5.h.
- Alertmanager installed but no routing destinations. Phase 8.
- No Loki/Tempo/OTel Collector (logs + traces). Phase 8+ or dedicated Phase 3.5.
- Custom per-operator dashboards deferred (Task 3.6). Chart's dashboards are generic-Kubernetes-focused, not per-operator specific.
- SSA `directory.recurse: false` drift trap from ADR-0015 hit again during Task 3.5 verification (temporarily showed OutOfSync on kube-prometheus-stack Application). Same class of issue; same fix pattern.

## ADRs written this phase

| # | Decision | Why interesting for portfolio |
|---|---|---|
| [ADR-0023](../adr/0023-metrics-server-vs-prometheus.md) | Install metrics-server separately from Prometheus stack + use `--kubelet-insecure-tls` on kind | Documents the two-systems distinction (they're complementary, not competing) + kind TLS gotcha with the exact error message for grep-ability. |
| [ADR-0024](../adr/0024-kube-prometheus-stack.md) | Install kube-prometheus-stack bundle as one ArgoCD Application | Bundle-vs-à-la-carte reasoning; storage sizing rationale (empirical numbers); Prometheus PVC/retention on kind. **Postscript on the ServiceMonitor selector filter trap** — the "why aren't my SMs being scraped?" mystery, documented with the exact fix (`serviceMonitorSelectorNilUsesHelmValues: false`). |
| [ADR-0025](../adr/0025-servicemonitor-strategy.md) | ServiceMonitor strategy: enable via chart values where supported, hand-write only where necessary | Hybrid pattern reasoning; Vault deferral with security trade-off. |

---

## Wave 2 — Logs (Loki) + Traces (Tempo)

- **Status:** ✅ Shipped 2026-09-08
- **Started:** 2026-08-12
- **Finished:** 2026-09-08
- **Duration:** ~4 focused sessions across ~4 weeks calendar time
- **Total AWS spend:** **$0** (still all on kind)
- **Docker Desktop VM bump:** 8 GiB → 12 GiB (Wave 2 pods added ~2.5 GiB memory footprint across 15 pods)

## Wave 2 business problem

Wave 1 answered *"is the platform up? how loaded?"* — quantitative aggregate signals. When something breaks, metrics tell you *that* it broke, not *why*. On-call gets paged: "5xx spike at 14:03." Without logs, you're guessing which pod. Without traces, you're guessing which downstream service.

**Logs** = every pod's stdout, cross-namespace queryable via LogQL. **Traces** = every request's flow across services with per-hop latency. Together with metrics = the observability triangle — standard SRE toolkit for the last decade. **MTTR drops from hours (guess-and-grep) to minutes (query-drill-down).**

## Wave 2 architecture — what runs now

```text
                CLUSTER (Wave 2 additions on top of Wave 1)
    ┌──────────────────────────────────────────────────────────┐
    │                                                          │
    │  observability namespace (15 pods)                       │
    │   ├── loki-distributor (Deployment)   ← Alloy pushes     │
    │   ├── loki-ingester-0 (StatefulSet, 5Gi PVC)             │
    │   ├── loki-querier (Deployment)                          │
    │   ├── loki-query-frontend (Deployment)                   │
    │   ├── loki-query-scheduler (Deployment)                  │
    │   ├── loki-compactor-0 (StatefulSet, 2Gi PVC)            │
    │   ├── loki-index-gateway-0 (StatefulSet, 2Gi PVC)        │
    │   ├── loki-gateway (Deployment)      ← nginx entry       │
    │   │                                                      │
    │   ├── tempo-distributor (Deployment)  ← OTel pushes      │
    │   ├── tempo-ingester-0 (StatefulSet, 5Gi PVC)            │
    │   ├── tempo-querier (Deployment)                         │
    │   ├── tempo-query-frontend (Deployment)                  │
    │   ├── tempo-compactor (Deployment)                       │
    │   ├── tempo-gateway (Deployment)     ← nginx entry       │
    │   │                                                      │
    │   ├── otel-collector (Deployment × 1) ← apps push OTLP   │
    │   │                                                      │
    │   └── alloy (DaemonSet × 1 per node)  ← reads pod logs   │
    │                                                          │
    │  minio namespace                                         │
    │   └── minio (StatefulSet, 10Gi PVC)                      │
    │        └── buckets: loki-chunks, tempo-blocks            │
    │                                                          │
    │  monitoring namespace (Wave 1 Grafana extended)          │
    │   └── grafana                                            │
    │        ├── Prometheus datasource (from Wave 1)           │
    │        ├── Loki datasource (new — with derivedFields     │
    │        │    trace_id regex → jump to Tempo)              │
    │        └── Tempo datasource (new — with tracesToLogsV2,  │
    │             tracesToMetrics, nodeGraph, serviceMap,      │
    │             streaming search)                            │
    │                                                          │
    └──────────────────────────────────────────────────────────┘

    Log flow:    pod stdout → Alloy → loki-gateway → distributor → ingester → MinIO chunks
    Trace flow:  app SDK → otel-collector → tempo-distributor → tempo-ingester → MinIO blocks
    Query:       Grafana Explore → loki-gateway / tempo-gateway → cross-linked drill-down
```

**Wave 2 pod count:** 15 (Loki 8 + Tempo 6 + Alloy 1). MinIO adds 1 more. Total observability footprint (Wave 1 + Wave 2): ~24 pods.

## What Wave 2 shipped

| Task | Component | Chart pin | Commits |
|---|---|---|---|
| 3.5.1 | Docker Desktop VM 8 → 12 GiB + Vault re-unseal per FM1 | — | (manual) |
| 3.5.2 | MinIO standalone (S3-compatible object storage) + Vault-managed credentials via ESO | `minio/minio 5.3.0` | `cb64bbf`, `97f91ea`, `3c7056b`, `afd4d09` |
| 3.5.3 | Loki distributed (8 pods) + Grafana Alloy log shipper (DaemonSet) | `grafana/loki 6.16.0` + `grafana/alloy 0.7.0` | `793719d`, `5b05787`, `21471c5`, `397903d`, `c3dc106` |
| 3.5.4 | Tempo distributed (6 pods) | `grafana/tempo-distributed 1.24.0` | `5a7e2e5`, `01a16b2` |
| 3.5.5 | OpenTelemetry Collector (Deployment × 1) | `open-telemetry/opentelemetry-collector 0.111.0` | `0fb28ef`, `a8ace47` |
| 3.5.6 | Grafana datasource wiring (Loki + Tempo + derivedFields + tracesToLogsV2) | Wave 1 chart extended | `3a38b72` |
| 3.5.7 | This close-out log + memory + housekeeping | — | (this commit) |

## The Wave 2 debugging arc — 12 bugs banked as institutional knowledge

Wave 2 was heavy on troubleshooting. Every one below was diagnosed, fixed, and documented as a permanent artifact — postscript, code comment, or runbook patch. Zero re-derivation cost next time.

### MinIO install (bugs 1-3)

1. **`vault kv put kv/minio/root` returned 403.** Wrong mount path — Phase 2's Vault has KV mounted at `secret/`, not `kv/` (the ClusterSecretStore is misleadingly named `vault-kv`). Fix: use `-mount=secret minio/root`.
2. **`vault kv put` preflight check 403 even with root token.** Vault CLI's `kv put` runs a preflight against `/sys/internal/ui/mounts/<path>` that can 403 in edge cases. Fix: use `-mount=<name>` flag to skip preflight.
3. **ExternalSecret CRD-injected defaults caused chronic ArgoCD OutOfSync.** CRD auto-populates `conversionStrategy`, `decodingStrategy`, `metadataPolicy`, `deletionPolicy` on apply — our YAML didn't declare them. This became runbook **FM6** ("Chart-injected defaults") applying broadly to any CRD with schema defaults.

### Loki + Alloy install (bugs 4-10, numbering continues)

<!-- markdownlint-disable MD029 -->
4. **Alloy River syntax error** — used `sys.env("HOSTNAME")` which doesn't exist. Correct is top-level `env()` function. Fix in `5b05787`.
5. **Loki chart validation blocked "mixed deployment mode".** When `deploymentMode: Distributed`, must explicitly zero out `backend/read/write/singleBinary` replicas — chart defaults leave them non-zero.
6. **Chart doesn't propagate `loki.extraEnv` to component pods.** Setting env vars under the `loki:` key affects Loki's Go config template only, not pod specs. Fix: `extraEnvFrom: [secretRef]` on every component (distributor, ingester, querier, ...) individually.
7. **Ingester zone-aware replication schedules 3 zones on 1 node.** Chart default creates 3 ingester zones (a/b/c) with pod anti-affinity forcing different nodes. On single-node kind, only zone-a schedules. Fix: `zoneAwareReplication.enabled: false`.
8. **Query-frontend requires query-scheduler in Distributed mode.** Chart default `queryScheduler.replicas: 0` breaks query-frontend with "number of schedulers this worker is connected to is 0". Fix: `queryScheduler.replicas: 1`.
9. **Chart hardcodes ingester `requiredDuringScheduling` podAntiAffinity.** `affinity: {}` values-level override doesn't apply — helper template always emits the rule. Fix: `kubectl patch` to strip it live + `ignoreDifferences` on `/spec/template/spec/affinity` to prevent re-inject on sync.
10. **Loki rejects log entries older than 1h by default.** Alloy scrapes kubelet's log tail which spans hours. Chart default `reject_old_samples_max_age` is too strict. Fix: `168h` to match retention window.

### Tempo install (bug 11)

11. **Cross-chart anti-affinity collision.** Both Loki + Tempo use `app.kubernetes.io/component: ingester|distributor|gateway|querier` labels without instance scoping in their anti-affinity rules. Loki's ingester's rule "no other ingester on my node" matches Tempo's ingester (both carry component=ingester). All 6 Tempo pods stuck Pending. Fix: same `ignoreDifferences` + `kubectl patch` pattern from bug 9, applied to both charts. Real multi-node clusters (EKS) wouldn't hit this.

### OTel Collector integration (bugs 12-13)

12. **Tempo distributor's `receivers: null` — no OTLP port exposed.** tempo-distributed chart doesn't enable any receiver protocols by default. OTel Collector's exporter times out. Fix: `traces.otlp.{grpc,http}.enabled: true`.
13. **Tempo ingester lifecycler default `replication_factor: 3` blocks writes.** We run 1 ingester replica on kind — writes hang forever waiting for 3 ready ingesters. Fix: `ingester.config.replication_factor: 1`.
<!-- markdownlint-enable MD029 -->

**Bonus:** ArgoCD chart-rendered StatefulSet drift — same K8s-injected default pattern as FM6, but for chart-rendered resources we can't declare defaults in git. Fix pattern: **`ServerSideDiff=true` + `RespectIgnoreDifferences=true`** sync options — ArgoCD 2.10+ computes diffs via kubectl dry-run apply on apiserver, correctly attributing K8s-injected defaults to the apiserver's ownership. Cleaner than enumerating jsonPointers. Applied to Loki + Tempo apps.

## Non-obvious institutional knowledge — Wave 2

- **Chart-cross-chart anti-affinity collision on single-node kind** is a real class of bug. Any two charts that follow the "component label + hostname anti-affinity" convention will deadlock when the second one installs. Multi-node clusters mask this entirely.
- **AWS SDK env-var conventions unlock chart-agnostic credentials.** Setting `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` via `extraEnvFrom` works for Loki, Tempo, and any other S3 client without needing chart-specific `existingSecret` support or `-config.expand-env` machinery.
- **The MinIO/S3 abstraction pays off immediately.** Same chart-level config on kind (MinIO endpoint) and future EKS (S3 endpoint) — differs only in URL + auth mechanism. ADR-0029's "kind uses in-cluster X, EKS uses managed X" pattern proven in practice.
- **CRD-injected defaults are ubiquitous.** ExternalSecret, StatefulSet, most Crossplane CRs, cert-manager Certificate, Istio VirtualService — all inject defaults on apply. FM6 documents the two mitigations: declare defaults in git (when you own the YAML) or ServerSideDiff+ignoreDifferences (when chart-rendered).
- **Grafana's `derivedFields` regex on Loki datasource is the single most impactful UX line.** One regex (`trace_id=(\w+)`) turns every log line with a trace ID into a clickable jump to Tempo. Backend + frontend integration in ~5 lines of YAML.
- **`streamingEnabled.search: true` on Tempo datasource** shows trace search results as they arrive instead of waiting for the full response. Meaningful UX difference on slow queries.
- **Alloy DaemonSet needs `tolerations: [operator: Exists]` on kind.** Kind's single node is the control-plane; without tolerations, DaemonSet pods don't schedule anywhere.
- **Test spans have a shelf life.** Tempo's retention (72h on kind per ADR-0030) purges old test spans. Fresh test spans needed for verification if last session was >3 days ago.

## Explicit tech debt (Wave 2) with migration plan

- **`kubectl patch` on Loki + Tempo StatefulSets/Deployments to strip anti-affinity.** Runtime-only fix; not GitOps-clean. Fix trigger: chart upstream fixes the cross-chart-collision issue OR we move to multi-node kind (`kind create cluster --config multi-node.yaml`). Cost: ~1 session to test either path.
- **Single MinIO root credential shared by Loki + Tempo (MVP).** Both services can delete each other's data if either is compromised. Fix trigger: Phase 8 hardening. Fix: per-service scoped MinIO service accounts + IAM policies. Cost: ~1 session.
- **Debug exporter left on in OTel Collector config.** Logs every processed span to stdout — noisy at real trace volume. Fix trigger: Phase 6 Node.js template starts emitting real traces. Fix: drop verbosity to `basic` or remove exporter. 1-line change.
- **Loki `auth_enabled: false` (single-tenant mode).** No X-Scope-OrgID headers required. Fix trigger: multi-tenant deployment (multiple teams sharing one Loki). Wave 3 or Phase 8 candidate.
- **Prometheus exemplars not enabled.** Would let metric spike click through to specific trace. Requires apps to emit exemplars via OTel SDK. Fix trigger: Phase 6 Node.js template. Wave 3 unlocks the full observability triangle drill-down (currently we have logs ↔ traces bidirectional, but no Prom → trace).

## Deferred to Wave 3 — concrete punch list

Each item has a **trigger** (when it becomes non-optional) plus a **rough effort** estimate.

| # | Item | Trigger | Effort |
|---|---|---|---|
| 1 | Prometheus exemplars → trace cross-link | Phase 6 Node.js template emitting spans + metrics | 1 session (config only) |
| 2 | Tempo metrics-generator (service graphs from traces) | Nice-to-have; Phase 6 apps will benefit | 1 session |
| 3 | Loki multi-tenancy (`auth_enabled: true` + X-Scope-OrgID) | Multiple teams sharing one Loki | 1-2 sessions |
| 4 | Per-service scoped MinIO credentials + IAM policies | Phase 8 hardening | 1 session |
| 5 | Tail-based tracing sampling policy | Real prod trace volume > 100 spans/sec | 1-2 sessions |
| 6 | Log-based alerting (LogQL alert rules in Grafana) | Phase 8 alerting expansion | 1 session |
| 7 | OTel Collector `kubernetesAttributes` preset (auto-enrich spans with k8s metadata) | Phase 6+ apps generating traces | 1 session |
| 8 | Alloy also handles trace forwarding (retire OTel Collector) | When Alloy reaches feature-parity with OTel Collector for OTLP | Speculative — chart maturity dependent |
| 9 | Ingress + cert-manager Certificate at `observability.idp.seniormankelz.dev` | EKS activation (Phase 9) OR public demo | 1 session |

**Wave 3 total estimate:** 6-10 focused sessions. Could be split across weeks.

## PR-style review (Wave 2)

**Strengths:**

- Full observability triangle live. Metrics, logs, traces all queryable in one Grafana with cross-links.
- 15 new pods integrated cleanly — 12 bugs found and fixed, all documented for future contributors.
- MinIO abstraction proven: same chart config would work on EKS with just endpoint URL swap.
- **Grafana verified as querying itself** through the new Loki datasource — the tightest possible end-to-end validation.
- Pre-emptive fixes from earlier bugs applied to later installs — Tempo shipped in ~1 session because Loki lessons made the values file right the first time.
- **ServerSideDiff + RespectIgnoreDifferences pattern** documented — a better solution than jsonPointer enumeration for chart-rendered drift.

**Weaknesses (deferred, not blockers):**

- 3 kubectl-patch workarounds (Loki + Tempo anti-affinity). Runtime state doesn't match git. Documented but ugly.
- No real trace-emitting apps yet — trace pipeline validated only with manual test spans. Real validation in Phase 6.
- Tempo memcached warnings clutter logs (we disabled memcached but chart still resolves the missing DNS name every 60s). Cosmetic.
- Debug exporter left on in OTel Collector — noisy for real prod.
- 12 GiB Docker Desktop VM is high — adding Mimir (Wave 3 candidate) would push toward 16 GiB.

## ADRs written for Wave 2

| # | Decision | Why interesting for portfolio |
|---|---|---|
| [ADR-0029](../adr/0029-object-storage-strategy.md) | Object storage strategy: MinIO on kind, AWS S3 on EKS via Phase 4 ObjectBucket XRD | Callback to Phase 4's XRD — the platform provisions its own observability storage on EKS. Mirrors ADR-0020's ESO kind/EKS strategy shape. |
| [ADR-0030](../adr/0030-observability-wave-2-stack.md) | Wave 2 stack (Loki distributed + Alloy + Tempo distributed + OTel Collector) | Bundles 4 install decisions into one architectural narrative. Justifies distributed topology over single-binary for portfolio pattern-matching to EKS. |
| Runbook FM6 addition | Chart-injected default fields cause chronic OutOfSync | Documents the CRD-defaults + StatefulSet-defaults pattern with two mitigations (declare in git vs ignoreDifferences). Real occurrence: MinIO ExternalSecret. |

## Interview talking points

**Wave 1 (metrics):**

- *"metrics-server vs Prometheus?"* — complementary. metrics-server for the k8s Metrics API (kubectl top, HPA); Prometheus for rich observability with history. Both needed. On kind, metrics-server needs `--kubelet-insecure-tls` because kind's kubelets use self-signed certs — a well-known gotcha documented in ADR-0023.
- *"Why bundle Prometheus + Grafana + Alertmanager via kube-prometheus-stack instead of installing separately?"* — pre-built dashboards (~180), coordinated versioning, community-standard install path, and the ServiceMonitor CRD comes bundled. À la carte recreates weeks of glue for zero real benefit.
- *"Tell me about a Grafana bug you debugged."* — Grafana admin password drift between Secret and DB at first install. Chart's env-var-from-Secret pattern can race with Grafana's DB initialisation. Fix: `grafana cli admin reset-admin-password` inside the pod — bypasses the Secret entirely, writes directly to the DB.
- *"How does Prometheus discover what to scrape?"* — via ServiceMonitor CRs from prometheus-operator. Prometheus's own CR has a `serviceMonitorSelector` that filters. kube-prometheus-stack's default selector is `{release: kube-prometheus-stack}` — only chart-created SMs match. Fix: set `serviceMonitorSelectorNilUsesHelmValues: false` in Helm values so the selector opens to everything. Well-known trap; documented as ADR-0024 postscript.

**Wave 2 (logs + traces):**

- *"How does the observability triangle actually connect?"* — Grafana datasources with derivedFields on Loki (regex extracts trace_id → click jumps to Tempo) and tracesToLogsV2 on Tempo (span tags → Loki query at that time window). Bidirectional. Config lives in the Wave 1 Grafana values (kube-prometheus-stack chart) as `additionalDataSources`.
- *"You mentioned 12 bugs in one phase — what was the most interesting?"* — cross-chart anti-affinity collision on single-node kind. Loki + Tempo both use `component: ingester` labels without instance scoping in their anti-affinity rules. Loki's ingester's rule "no other ingester on my node" matches Tempo's. Deadlocks the second chart. Real multi-node clusters (EKS) don't hit this — it's a kind-specific class of bug that portfolio projects on kind will constantly hit.
- *"How do you handle drift between what your git YAML says and what Kubernetes actually stores?"* — two patterns per runbook FM6. If you own the YAML (e.g. ExternalSecret CR), declare the CRD-injected defaults explicitly. If chart-rendered (e.g. Loki's StatefulSets), use `ServerSideDiff=true` + `RespectIgnoreDifferences=true` on the ArgoCD Application — ArgoCD asks the apiserver "what would you actually change if I applied this?" via dry-run, correctly attributing injected defaults to the apiserver.
- *"Why MinIO on kind if EKS gets S3 anyway?"* — S3-API abstraction. Same Loki/Tempo config on both — differs only in endpoint URL + credentials. On EKS, MinIO gets replaced by ObjectBucket XRCs from our Phase 4 XRD — the platform provisions its own observability storage. Nice portfolio callback.
- *"Why distributed Loki + distributed Tempo on kind, not single-binary?"* — same config as EKS. Single-binary is fine for a demo but doesn't teach the microservices topology. Distributed adds ~2.5 GiB memory + ~10 pods but the config we run on kind is identical to what we'd run on EKS. That's the portfolio story.

## LinkedIn post idea

**Hook:** "I ran Loki + Tempo distributed on kind and hit 12 bugs the tutorials skip. Here's what you'll want to know before you try."

**Body:** short recap of the debugging arc — cross-chart anti-affinity, chart-doesn't-propagate-global-env, CRD-injected defaults causing chronic OutOfSync, Loki's default 1h rejection window, Tempo's default replication_factor=3 hanging on single-replica. Each one banked as an ADR postscript or runbook entry.

**CTA:** link to phase log + specific commits. "Every workaround is in a code comment. Every trade-off is in an ADR. Wave 3 punch list is pre-planned. This is what I mean by 'engineering, not shipping.'"

## YouTube video idea

**Title:** "Full observability on kind in one afternoon (and the 12 bugs I hit)"

**Structure (15-20 min):**

1. Wave 1 recap: metrics via kube-prometheus-stack
2. Wave 2 goal: complete the observability triangle
3. MinIO storage decision (kind-vs-EKS abstraction)
4. Loki distributed install + the 7 bugs it threw
5. Tempo distributed install + cross-chart anti-affinity collision (bug story!)
6. OTel Collector + the "receivers: null" trap
7. Grafana datasource wiring + the drill-down demo
8. Wave 3 preview: exemplars + service graphs + tail sampling

**Selling point:** unlike most observability videos (single-binary Loki demo on someone's laptop), this shows the full production topology + all gotchas + how to work around them on constrained infrastructure.

---

## What's next — Phase 4 (already shipped)

**Phase 4 — Crossplane** already shipped after Wave 1 (see [phase-4-crossplane.md](phase-4-crossplane.md)). Wave 2 completed after Phase 5.

## Immediate next options

1. **Phase 6 (Golden Path Templates, Node.js)** — first real service, will emit logs (structured JSON with trace_id) + traces (OTel SDK). Immediately proves Wave 2's cross-linked drill-down with real data. Also fills tempo-blocks bucket properly.
2. **Phase 5 Wave 2 (Backstage polish)** — custom image + OAuth + ArgoCD plugin + Scaffolder + TechDocs. 6-10 sessions.
3. **Phase 3 Wave 3 (this phase, tier 3)** — exemplars + metrics-generator + tail sampling + per-service MinIO creds. 6-10 sessions.
4. **Phase 8 (Security hardening)** — Kyverno + NetworkPolicy + Pod Security Standards + image signing. Applies retroactively to everything.

Session opener for whichever: *"start Phase 6 golden paths"*, *"start Phase 5 Wave 2"*, *"start Phase 3 Wave 3 exemplars + service graphs"*, or *"start Phase 8 security hardening"*.

## See also

- [ADR-0029](../adr/0029-object-storage-strategy.md) — object storage strategy
- [ADR-0030](../adr/0030-observability-wave-2-stack.md) — Wave 2 stack
- [platform/observability/README.md](../../platform/observability/README.md) — Wave 2 credentials + install order
- [platform/minio/README.md](../../platform/minio/README.md) — MinIO layout + Vault seed procedure
- [docs/runbooks/kind-recovery.md](../runbooks/kind-recovery.md) FM6 — chart-injected defaults drift pattern
