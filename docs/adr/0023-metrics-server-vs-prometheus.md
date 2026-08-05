# 0023 — Install metrics-server separately from the Prometheus stack; use `--kubelet-insecure-tls` on kind

- **Status:** Accepted
- **Date:** 2026-08-05
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 3's job is observability. metrics-server and Prometheus are both "metrics" tools — easy to conflate. They're not the same thing, they solve different problems, and this platform needs both. This ADR records that decision explicitly so future contributors don't assume "we have Prometheus, do we still need metrics-server?" (yes) or vice-versa.

Secondary: metrics-server on kind hits a well-known TLS-verification gotcha that silently breaks `kubectl top`. Documenting the fix in-repo so nobody re-derives it.

## Decision drivers

1. **Kubernetes-native APIs must work.** HPA, VPA, `kubectl top` — all rely on the Kubernetes Metrics API served by metrics-server. Without it, k8s autoscaling is broken.
2. **Observability engineering needs richer data than metrics-server exposes.** Rate/latency/histograms/labels — none served by metrics-server, all served by Prometheus.
3. **Chart maintainer decisions.** Chart 3.13.1 pins app v0.8.1; we accept the tested pair rather than forcing a newer image tag.
4. **kind-specific TLS behaviour.** kubelets on kind use self-signed certs — verification fails without `--kubelet-insecure-tls`.

## Options considered

### Option A — Install metrics-server (chosen)

Deploy `metrics-server` as its own ArgoCD Application, chart pinned to `3.13.1`, with `--kubelet-insecure-tls` for kind. Prometheus (Task 3.3, kube-prometheus-stack) is a separate concern with its own Application.

- Pros: Correct architecture. Two components solving two different problems. `kubectl top` works. HPA works. Prometheus does the rich observability.
- Cons: Two operators to install and update instead of one.

### Option B — Skip metrics-server, use Prometheus adapter

Install `prometheus-adapter` alongside kube-prometheus-stack. The adapter translates Prometheus queries into the Kubernetes Metrics API shape, so HPA can autoscale from any Prometheus metric.

- Pros: One metrics source (Prometheus) drives everything, including HPA. Enables custom-metric autoscaling ("scale based on p99 latency").
- Cons: Overkill for Phase 3. HPA-on-CPU is the 80/20 case and metrics-server handles it natively. prometheus-adapter is a Phase 8+ concern when we actually have custom-metric autoscaling requirements.

### Option C — Skip metrics-server, no HPA / kubectl top

Just install Prometheus. Accept that `kubectl top` doesn't work and HPA is unavailable.

- Pros: One less operator to maintain.
- Cons: Kubernetes-native APIs broken. `kubectl top` is a basic operational tool — losing it is a real regression.

## Decision

**Option A — metrics-server as its own Application.**

Reason: it's the right architecture. metrics-server is a small, stable, single-purpose component serving the Kubernetes Metrics API. Prometheus is a separate large system serving rich observability. Bundling them (Option B via prometheus-adapter) is overkill until custom-metric autoscaling is needed (Phase 8+). Not installing metrics-server (Option C) breaks kubectl top and HPA — regressions for zero real benefit.

**Chart pin: `3.13.1`, accept default app version `v0.8.1`.** The chart maintainer tested this pair; forcing app v0.9.0 via `image.tag` override risks values-schema mismatches. metrics-server has an extremely slow release cadence (v0.8.0 → v0.8.1 in a year, v0.8 → v0.9 in another year), so "wait for the chart to catch up" is safe.

## Consequences

- **Positive:** `kubectl top nodes` and `kubectl top pods` work. HPA can autoscale on CPU/memory. Small footprint (single pod). Complements Prometheus without overlap.
- **Negative:** Two metrics-related components to maintain instead of one. Small ongoing cost.
- **Neutral:** metrics-server's ~1 minute retention is intentional — HPA only needs current state, not history. Anyone looking for history uses Prometheus.

## The kind TLS gotcha — permanent fix

metrics-server scrapes each kubelet's `/metrics/resource` endpoint over HTTPS. By default it verifies the kubelet's TLS certificate chain.

**On kind, kubelets use self-signed certs.** Verification fails silently — metrics-server pod comes up Running but every scrape errors:

```text
Failed probe metrics: unable to fully scrape metrics: unable to fully scrape metrics from
node <name>: unable to fetch metrics from node <name>: Get "https://<node-ip>:10250/metrics/resource":
tls: failed to verify certificate: x509: cannot validate certificate for <node-ip> because
it doesn't contain any IP SANs
```

`kubectl top nodes` returns:

```text
error: Metrics API not available
```

**Fix:** add `--kubelet-insecure-tls` to metrics-server's container args. Committed inline in `platform/argocd/apps/metrics-server.yaml` under `helm.valuesObject.args`.

**Do NOT set on EKS.** EKS kubelets have proper cert chains via the cluster's CA; verification succeeds without the flag. Task 3.3+ can safely omit it when the ArgoCD Application is deployed to EKS. Two options for handling this at Phase 9 activation:

1. **Values override per environment** — use different `helm.valuesObject.args` for kind vs EKS. Requires branching by env in ArgoCD (e.g., ApplicationSet with cluster-generator).
2. **Leave the flag on** — `--kubelet-insecure-tls` on EKS also works (verification just gets skipped, no functional difference for a single-tenant cluster). Small hardening loss, big simplicity win.

**Recommendation for Phase 9:** Option 1 (env-specific values). Defense in depth — even if a rogue node injected itself into an EKS cluster, cert verification would catch it. Small cost, real security value.

## When to revisit

- **If we need custom-metric autoscaling** (HPA on request rate, queue depth, external metrics). Add `prometheus-adapter` alongside metrics-server. Don't remove metrics-server — the adapter augments, doesn't replace.
- **If we adopt VPA (Vertical Pod Autoscaler).** VPA also uses the Metrics API served by metrics-server.
- **When Phase 9 EKS activation.** Split `helm.valuesObject.args` by environment (see kind TLS section).

## Related decisions

- [ADR-0016](0016-cert-manager-install-via-helm.md) — the "Helm chart via ArgoCD Application" pattern this ADR follows.
- Future Task 3.3 ADR (kube-prometheus-stack) — the Prometheus install this ADR explicitly complements.

## References

- [metrics-server GitHub](https://github.com/kubernetes-sigs/metrics-server)
- [Kubernetes Metrics API documentation](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [The `--kubelet-insecure-tls` gotcha (Stack Overflow example)](https://stackoverflow.com/questions/54106725/docker-kubernetes-mac-autoscaler-unable-to-find-metrics)
- [prometheus-adapter (for when we need custom-metric HPA)](https://github.com/kubernetes-sigs/prometheus-adapter)

## Interview framing

The one-liner: *"metrics-server and Prometheus are complementary, not competing. metrics-server serves the built-in Kubernetes Metrics API for `kubectl top` and HPA — basic CPU/memory, in-memory, ~1 minute retention. Prometheus does everything else — rich metrics, dashboards, alerting, history. Both are needed. On kind, metrics-server needs `--kubelet-insecure-tls` because kind's kubelets use self-signed certs — a well-known gotcha documented inline in the Application manifest and this ADR."*
