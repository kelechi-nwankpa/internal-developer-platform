# 0024 — Install kube-prometheus-stack bundle (Prometheus + Grafana + Alertmanager + operator) as one ArgoCD Application

- **Status:** Accepted
- **Date:** 2026-08-05
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 3's core is metrics. [ADR-0023](0023-metrics-server-vs-prometheus.md) installed metrics-server for the Kubernetes-native Metrics API (kubectl top, HPA). This ADR covers the rest: Prometheus for rich time-series metrics, Grafana for dashboards, Alertmanager for alert routing, plus the prometheus-operator that manages their CRDs.

Two shapes for shipping this: bundle it all via `kube-prometheus-stack` (single Helm chart from `prometheus-community`) or install each component à la carte (5+ separate ArgoCD Applications).

## Decision drivers

1. **Portfolio narrative + real-world alignment.** `kube-prometheus-stack` is the community-standard install path. Every troubleshooting guide, blog post, and StackOverflow answer assumes it.
2. **Pre-built dashboards are load-bearing value.** Chart ships ~180 curated Kubernetes dashboards (nodes, pods, workload, apiserver, etcd, kubelet, cAdvisor, etc.). Recreating these à la carte is weeks of work.
3. **CRD ecosystem consistency.** `ServiceMonitor`, `PodMonitor`, `PrometheusRule`, `Alertmanager`, `Prometheus`, `ThanosRuler` all come from prometheus-operator. All chart-managed together.
4. **Application count under app-of-apps.** Bundled = 1 Application. À la carte = 5-6. Fewer moving parts.
5. **Upgrade coordination.** Chart maintainers test the bundle's Prometheus + Grafana + Alertmanager + operator versions together. À la carte means you own the compat matrix.
6. **Blast radius on failure.** Bundled failure = one Application red. À la carte = potentially several. Both recoverable.

## Options considered

### Option A — kube-prometheus-stack bundle (chosen)

Single `prometheus-community/kube-prometheus-stack` chart, one ArgoCD Application. All 6 sub-components (Prometheus, Grafana, Alertmanager, prometheus-operator, kube-state-metrics, node-exporter) enabled.

- Pros: Community-standard. Pre-built dashboards. Coordinated versions. Single Application. Every upstream doc applies directly. Bundled CRDs.
- Cons: Large blob — ~10 pods land at once, harder to reason about "what installed what." Chart's values surface is enormous (~800 lines of possible overrides).

### Option B — À la carte individual charts

Install Prometheus (`prometheus-community/prometheus`), Grafana (`grafana/grafana`), Alertmanager (`prometheus-community/alertmanager`), prometheus-operator (`prometheus-community/prometheus-operator`), kube-state-metrics, node-exporter as separate ArgoCD Applications. Wire ServiceMonitors, PrometheusRules, dashboards manually.

- Pros: Fine-grained control over each component's version + values. Clean separation in app-of-apps.
- Cons: **Recreates a lot of glue.** kube-prometheus-stack ships ServiceMonitors for kubelet, cAdvisor, node-exporter, kube-state-metrics, apiserver, etcd, kube-controller-manager, kube-scheduler — all wired to Prometheus. À la carte means writing all of these by hand. Same for the 180 dashboards, all the alerting rules for common Kubernetes failures, and coordinating Prometheus + operator + Grafana version compat. Weeks of work for zero real benefit over the bundle.

### Option C — Skip Prometheus entirely, just metrics-server

Only the k8s Metrics API. No dashboards, no history, no alerting.

- Pros: One less operator.
- Cons: No observability engineering possible. Regressions in Phase 6+ workloads become invisible. Rejected — this is a Phase 3 whose whole purpose is observability.

## Decision

**Option A — kube-prometheus-stack bundle.**

The pre-built dashboards + community-standard install path + coordinated versioning outweigh the "large blob" concern. If we ever hit an actual reason to un-bundle a specific component (e.g., need Grafana on a different upgrade cadence than Prometheus), we can extract that component into its own Application later. Until then, the bundle is the right shape.

## Consequences

- **Positive:** ~10 pods land under one Application. ~180 pre-built dashboards work immediately. `ServiceMonitor` CRD available for Task 3.5 (wire our Phase 2 operators). PrometheusRule CRD available for custom alerts. Standard community troubleshooting path applies (every "kube-prometheus-stack" search on Stack Overflow is applicable).
- **Negative:** ~800-line values-surface to reason about. Any specific tweak requires digging through the chart's `values.yaml` on Artifact Hub. The bundle's upgrade cadence may not match how often we want to upgrade individual components (in practice: not a real concern — bundle ships weekly patches).
- **Neutral:** Bundle namespace is `monitoring` (chart convention). Not to be confused with `observability` (some alternative installs) or `prometheus` (older installs). Grafana admin password is chart-auto-generated; same rotation discipline as ArgoCD applies (retrieve, log in, rotate, delete initial secret — Task 3.4 covers this).

## Storage sizing rationale

Kind local dev, 24h retention. Empirical: Prometheus scraping a Phase 2 cluster (7 operators + metrics-server + node-exporter + kube-state-metrics) at 30s intervals for 24h generates roughly 400–500 MiB of TSDB data.

- **Prometheus PVC: 2 GiB** — 4× headroom over the empirical baseline. Room for adding ServiceMonitors in Task 3.5 without a resize.
- **Alertmanager PVC: 1 GiB** — modest; Alertmanager stores dedup/silence state and doesn't grow much.
- **Grafana PVC: 1 GiB** — dashboards + users + settings. Small.

Total PVC allocation: 4 GiB. Kind's Docker Desktop VM has ~30 GiB by default; comfortable.

**EKS in Phase 9** — bump Prometheus retention to 15d (default) and storage to 50 GiB, or add Thanos sidecar for object-storage-backed long-term retention. Grafana + Alertmanager sizes are fine as-is.

## When to revisit

- **When we need custom-metric HPA.** Add `prometheus-adapter` as a separate Application. Not part of the bundle.
- **When we go EKS (Phase 9).** Add Thanos sidecar for long-term storage on S3. Bump Prometheus retention. Add Ingress + real TLS cert for Grafana.
- **When we need Loki + Tempo** (deferred per Phase 3 scope decision). Separate Applications. Grafana datasources get added then.
- **If we hit a bundle-vs-component version conflict.** E.g., need a specific Grafana feature that requires a newer version than what the bundle pins. Extract Grafana into its own Application. Not before.

## Related decisions

- [ADR-0016](0016-cert-manager-install-via-helm.md) — the "Helm via ArgoCD Application" pattern this ADR follows.
- [ADR-0023](0023-metrics-server-vs-prometheus.md) — metrics-server (this ADR's sibling; kubectl top + HPA vs rich observability).
- Future Task 3.5 ADR — ServiceMonitors for Phase 2 operators. Will reference the `ServiceMonitor` CRD this bundle installs.
- Future Phase 8 — Alertmanager routing destinations (Slack, PagerDuty).
- Future Phase 9 — Thanos sidecar, Ingress for Grafana, longer retention.

## References

- [kube-prometheus-stack chart on Artifact Hub](https://artifacthub.io/packages/helm/prometheus-community/kube-prometheus-stack)
- [prometheus-operator design docs](https://prometheus-operator.dev/docs/getting-started/design/)
- [Grafana dashboards library](https://grafana.com/grafana/dashboards/)
- [Prometheus retention + storage sizing guide](https://prometheus.io/docs/prometheus/latest/storage/)

## Interview framing

The one-liner: *"kube-prometheus-stack is a meta-chart bundling Prometheus + Grafana + Alertmanager + prometheus-operator + kube-state-metrics + node-exporter into one Helm release. Community-standard, ships ~180 pre-built dashboards, coordinates versions. We install it as a single ArgoCD Application. Per-component ServiceMonitors for our Phase 2 operators are a separate concern (Task 3.5). Storage is PVC-backed with 24h retention on kind; EKS bumps to 15d or Thanos for long-term. Grafana admin follows the same 'rotate + delete initial secret' discipline as ArgoCD."*
