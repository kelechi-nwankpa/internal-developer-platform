# 0025 — ServiceMonitor strategy: enable via chart values where supported, hand-write only where necessary

- **Status:** Accepted
- **Date:** 2026-08-05
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

[ADR-0024](0024-kube-prometheus-stack.md) installed kube-prometheus-stack, which brought the `ServiceMonitor` CRD (from prometheus-operator) to the cluster. Prometheus is running but only scraping the "built-in" targets (kubelet, cAdvisor, node-exporter, kube-state-metrics, prometheus itself). None of our Phase 2 operators are being scraped.

Task 3.5's job is to fix that — wire Prometheus to scrape `/metrics` from every Phase 2 operator that exposes it (cert-manager, ESO, ExternalDNS, Vault, ArgoCD). Two shapes for creating the ServiceMonitors: enable via each chart's built-in `serviceMonitor.enabled` value (chart writes the CR), or hand-write ServiceMonitor manifests in this repo and manage them as a separate Application.

## Decision drivers

1. **Maintainability across chart upgrades.** If a chart bumps its metrics port or changes Service label conventions, chart-native SMs update automatically. Hand-rolled SMs break silently.
2. **Chart-native support varies.** cert-manager (Jetstack), external-secrets, external-dns, and Vault all support `serviceMonitor.enabled: true` (or equivalent). ArgoCD does not — it's installed from raw manifests per ADR-0014, so there's no chart to configure.
3. **Uniformity vs pragmatism.** A single hand-rolled approach for every operator would be uniform but ignores the chart-native path where it exists.
4. **Vault has special complexity.** Vault's `/v1/sys/metrics` endpoint requires either an authenticated token OR a `telemetry` stanza in the Vault HCL config with `unauthenticated_metrics_access = true`. Non-trivial change to `platform/argocd/apps/vault.yaml` — worth its own sub-task rather than bundling.

## Options considered

### Option A — All chart values (where supported); skip anything without

Enable `serviceMonitor` chart values on cert-manager, ESO, ExternalDNS, Vault. Skip ArgoCD entirely.

- Pros: Purely chart-native. Zero hand-written manifests.
- Cons: ArgoCD's metrics don't get scraped — a real loss. Application-controller reconcile duration, sync duration, and repo-server metrics are among the most operationally-interesting we have.

### Option B — All hand-rolled ServiceMonitor manifests

Write custom ServiceMonitor CRs for every operator in `platform/monitoring/`. Wrap in a new ArgoCD Application. Ignore chart-native support.

- Pros: Uniform. Full control over the (port, path, label-selector, interval) tuple per operator.
- Cons: **Ownership burden.** Chart upgrades that change any of those tuples silently break scraping. Maintenance cost across every operator's release cycle.

### Option C — Hybrid: chart values where supported, hand-rolled where not (chosen)

Chart values for cert-manager, ESO, ExternalDNS. Hand-rolled ServiceMonitors for ArgoCD (no chart). Vault deferred to its own sub-task pending the telemetry-config decision.

- Pros: Maintenance-cheap for the chart-supported path (4 operators). Full control only where the chart can't help (ArgoCD). Small and focused hand-rolled scope.
- Cons: Two patterns to remember (chart values vs `platform/monitoring/`). Small documentation burden this ADR handles.

## Decision

**Option C — hybrid.**

The maintainability argument is decisive. Chart-native SMs update in lockstep with the chart itself; hand-rolled SMs are frozen at the time we wrote them and drift when the chart moves. For any operator that lets the chart write its own SM, use the chart. Hand-roll only when the chart can't help (ArgoCD, raw-manifest install per ADR-0014).

Vault is deferred to a separate sub-task because enabling its metrics endpoint requires editing the Vault HCL config in `platform/argocd/apps/vault.yaml` (add `telemetry { prometheus_retention_time = "..." disable_hostname = true unauthenticated_metrics_access = true }`) which is more than a values flip. Worth its own investigation to weigh the security trade-off of `unauthenticated_metrics_access`.

## Consequences

- **Positive:** cert-manager, ESO, ExternalDNS ServiceMonitors are chart-managed — future chart upgrades handle port/label/path changes automatically. ArgoCD SMs are stable because ArgoCD itself is a raw-manifest install and its Service labels haven't changed in years.
- **Negative:** Small documentation burden — two patterns coexist. Handled by this ADR + inline comments in the Application files (each cert-manager/ESO/ExternalDNS Application's values include a comment referencing this ADR).
- **Neutral:** ArgoCD ServiceMonitors live in `platform/monitoring/argocd-servicemonitors.yaml`. When Vault ServiceMonitor lands (its own sub-task), it goes in the same directory as `platform/monitoring/vault-servicemonitor.yaml`. Wrapping Application (`monitoring-servicemonitors`) picks up new files automatically because it points at the directory.

## When to revisit

- **When Vault's ServiceMonitor sub-task ships.** Add `vault-servicemonitor.yaml` to `platform/monitoring/`. Update ADR-0019 postscript documenting the Vault telemetry config decision.
- **If a chart drops its `serviceMonitor.enabled` value** (unlikely — prometheus-operator has become the community standard). We'd fall back to hand-rolling for that operator.
- **If we adopt a non-prometheus-operator scraping approach** (e.g., prometheus-agent, VictoriaMetrics operator). The CRD shape would change; ServiceMonitor concepts might not carry over 1:1.

## Related decisions

- [ADR-0014](0014-argocd-raw-install-vs-helm.md) — ArgoCD raw-manifest install (the reason ArgoCD alone needs hand-rolled SMs).
- [ADR-0016](0016-cert-manager-install-via-helm.md) — cert-manager Helm install (where the `prometheus.servicemonitor.enabled` value lives).
- [ADR-0018](0018-external-secrets-install-via-helm.md) — ESO Helm install (where `serviceMonitor.enabled` lives).
- [ADR-0019](0019-vault-install-for-eso-kind-backend.md) — Vault install (needs telemetry-config amendment for Prometheus scraping; deferred sub-task).
- [ADR-0021](0021-external-dns-install-and-provider-strategy.md) — ExternalDNS Helm install (where `serviceMonitor.enabled` lives).
- [ADR-0024](0024-kube-prometheus-stack.md) — kube-prometheus-stack (installed the ServiceMonitor CRD this ADR uses).

## References

- [prometheus-operator ServiceMonitor docs](https://prometheus-operator.dev/docs/api-reference/api/#monitoring.coreos.com/v1.ServiceMonitor)
- [cert-manager Helm chart values — prometheus.servicemonitor](https://cert-manager.io/docs/installation/helm/#option-1-installing-crds-with-helm-chart)
- [ExternalDNS Helm chart values — serviceMonitor](https://artifacthub.io/packages/helm/external-dns/external-dns)
- [ESO Helm chart values — serviceMonitor](https://artifacthub.io/packages/helm/external-secrets-operator/external-secrets)

## Interview framing

The one-liner: *"For ServiceMonitors — the CRs that tell Prometheus what to scrape — we prefer chart-native support (`serviceMonitor.enabled: true` in each Helm values) over hand-writing manifests. Chart-native SMs update in lockstep with chart upgrades; hand-rolled ones freeze at write-time and drift. The one operator we hand-roll for is ArgoCD, because ArgoCD itself is a raw-manifest install (ADR-0014, not Helm), so no chart-native path exists. Vault is deferred to its own sub-task because scraping Vault's `/v1/sys/metrics` requires either an auth token or `unauthenticated_metrics_access = true` in Vault's HCL — a decision with security trade-offs worth their own investigation."*
