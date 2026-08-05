# Phase 3 — Observability (metrics only; logs + traces deferred)

- **Status:** ✅ Shipped (metrics scope)
- **Started:** 2026-08-05
- **Finished:** 2026-08-05 (single-day compressed phase)
- **Duration:** 1 focused day, ~6 sessions
- **Total AWS spend:** **$0** (Phase 3 is local-first, same as Phase 2)
- **Scope note:** metrics stack shipped in full. Logs (Loki + Promtail) and traces (Tempo + OpenTelemetry Collector) deliberately deferred per the Phase 3 intro's Option B — separate future task/phase.

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

## What's next — Phase 4

**Phase 4 — Crossplane.** The Kubernetes-native infrastructure API. Every AWS resource an app team wants (RDS, S3, IAM roles) becomes a Kubernetes CR they can `kubectl apply`. Backstage in Phase 5 drives Crossplane via those CRs — golden paths become one click.

Phase 4 will heavily use the observability we just built — Crossplane's provider health, XR reconciliation duration, AWS API call latency all become dashboards + alerts.

Session opener for Phase 4: *"start Phase 4, Crossplane for K8s-native AWS infra."*

## Deferred sub-tasks (pick up when appropriate)

- **3.5.h** — Vault ServiceMonitor + telemetry config (own sub-task)
- **3.6** — Curated per-operator dashboards (portfolio polish)
- **3.7** — Alertmanager routing (Phase 8 destinations wiring)
- **3.9-ish** — Loki + Promtail + Tempo + OTel Collector (Phase 8 or dedicated Phase 3.5)

## Interview talking points

- *"metrics-server vs Prometheus?"* — complementary. metrics-server for the k8s Metrics API (kubectl top, HPA); Prometheus for rich observability with history. Both needed. On kind, metrics-server needs `--kubelet-insecure-tls` because kind's kubelets use self-signed certs — a well-known gotcha documented in ADR-0023.
- *"Why bundle Prometheus + Grafana + Alertmanager via kube-prometheus-stack instead of installing separately?"* — pre-built dashboards (~180), coordinated versioning, community-standard install path, and the ServiceMonitor CRD comes bundled. À la carte recreates weeks of glue for zero real benefit.
- *"Tell me about a Grafana bug you debugged."* — Grafana admin password drift between Secret and DB at first install. Chart's env-var-from-Secret pattern can race with Grafana's DB initialisation. Fix: `grafana cli admin reset-admin-password` inside the pod — bypasses the Secret entirely, writes directly to the DB.
- *"How does Prometheus discover what to scrape?"* — via ServiceMonitor CRs from prometheus-operator. Prometheus's own CR has a `serviceMonitorSelector` that filters. kube-prometheus-stack's default selector is `{release: kube-prometheus-stack}` — only chart-created SMs match. Fix: set `serviceMonitorSelectorNilUsesHelmValues: false` in Helm values so the selector opens to everything. Well-known trap; documented as ADR-0024 postscript.
- *"How do you monitor your own monitoring stack?"* — Prometheus scrapes itself + Alertmanager + Grafana + kube-state-metrics + node-exporter automatically. kube-state-metrics's `up{job="kube-prometheus-stack-prometheus"}` = 1 means Prometheus is scraping itself successfully.
