# 0030 — Observability Wave 2 stack: Loki + Alloy + Tempo + OTel Collector

- **Status:** Accepted
- **Date:** 2026-08-12
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Wave 1 shipped **metrics** (kube-prometheus-stack: Prometheus + Grafana + Alertmanager). Wave 2 adds the other two legs of the observability triangle: **logs** (Loki) and **traces** (Tempo). Both feed into the existing Grafana as new datasources, with cross-linking via metric exemplars and trace-ID → log-query derived fields.

Object storage (ADR-0029, MinIO on kind) is already in place — this ADR is about the **compute + shipping** side: which agents ship logs/traces, which backends store them, which topologies we use, and how they all wire together.

## Decision drivers

1. **Portfolio value.** "Full observability triangle wired to shared Grafana with cross-linked drill-downs" is a top-3 interview question for Platform Engineering / SRE roles. Half-measures (metrics only; metrics + logs; no traces) don't tell the full story.
2. **Real prod pattern.** No serious deployment runs Loki as a single-binary or Tempo without a collector. Distributed topologies + a proper collector agent are what interviewers expect to hear about.
3. **Modern tooling.** Grafana Alloy replaced Promtail (deprecated 2024). OpenTelemetry Collector is the CNCF standard for trace ingest. Choosing legacy tools would need justification.
4. **Bundle for one story.** Loki + Alloy + Tempo + OTel Collector arrive together in one wave — bundling into one ADR captures the whole "how we ship logs and traces" narrative in one place, matching ADR-0024's pattern (which bundled Prometheus + Grafana + Alertmanager + operator).
5. **kind-first, EKS-compatible.** Same charts + same config shape on kind and EKS. The only environment-specific thing is object-storage endpoint (already abstracted per ADR-0029) and, on EKS, IRSA-based auth.

## Options considered

### Option A — Loki distributed + Alloy + Tempo distributed + OTel Collector (chosen)

The full modern stack. Loki + Tempo in distributed topologies (separate ingester/querier/compactor/store-gateway pods). Alloy DaemonSet for log shipping. OTel Collector Deployment for trace ingest.

- **Pros:** Real prod pattern. Portfolio-defensible ("we run distributed Loki, not a single-binary demo"). Alloy is modern replacement for deprecated Promtail. OTel Collector is CNCF standard. Same charts + config on kind and EKS.
- **Cons:** More pods (~10-15 across the stack). More memory (~2-3 GiB total). More things to debug when broken. Distributed Loki config is genuinely complex — chart values will be dense.

### Option B — Loki single-binary + Promtail + Tempo single-binary + direct-to-Tempo

The "make it work" stack. Loki and Tempo each as one pod. Promtail (deprecated) as log shipper. No collector — apps send traces directly to Tempo.

- **Pros:** Fewer pods, less memory, simpler config. Faster to get running.
- **Cons:** Promtail deprecation debt on day 1. Single-binary Loki/Tempo don't teach the distributed pattern. Direct-to-Tempo means every app has to know Tempo's endpoint (fragile). No portfolio narrative beyond "I made it work."
- **Rejected because:** we're building portfolio-quality, not proof-of-life. The complexity delta over Option A is manageable given kind at 12 GiB VM.

### Option C — Loki + Tempo via Grafana Enterprise / Cloud

- **Pros:** Zero infra to run.
- **Cons:** Contradicts local-first + $0-until-Phase-9 project premise.
- **Rejected because:** portfolio value is in running the OSS stack ourselves.

### Option D — Alternative log/trace stacks (Fluentd + Elasticsearch + Jaeger)

- **Pros:** Different technology mix. Elasticsearch is more searchable than LogQL.
- **Cons:** Not the CNCF-standard set. Massive memory footprint (Elasticsearch alone would consume most of our kind VM). Slower community momentum than Grafana stack.
- **Rejected because:** the Grafana LGTM stack (Loki + Grafana + Tempo + Mimir) is the modern portfolio-relevant choice for 2026.

## Decision

**Option A: Loki distributed + Grafana Alloy + Tempo distributed + OpenTelemetry Collector.**

**Chart pins:**

- **Loki:** `grafana/loki` version `6.16.0` (distributed values profile). Chart supports single-binary + simple-scalable + distributed via `deploymentMode:` value.
- **Alloy:** `grafana/alloy` version `0.7.0`. Modern replacement for `grafana-agent`. Handles log scraping + optional metrics + trace forwarding.
- **Tempo:** `grafana/tempo-distributed` version `1.24.0`. Distributed profile is the default of this chart (vs `grafana/tempo` which is single-binary).
- **OTel Collector:** `open-telemetry/opentelemetry-collector` version `0.111.0`. Deployment mode (not DaemonSet) — one central collector receiving traces + forwarding to Tempo.

**Deployment topology:**

```text
                              CLUSTER
      ┌────────────────────────────────────────────────────────┐
      │                                                        │
      │  observability namespace                               │
      │                                                        │
      │   ├── loki-distributor (Deployment)   ← Alloy pushes   │
      │   ├── loki-ingester (StatefulSet)     ← chunk writer   │
      │   ├── loki-querier (Deployment)       ← query engine   │
      │   ├── loki-query-frontend (Deployment)                 │
      │   ├── loki-compactor (StatefulSet)    ← chunk merger   │
      │   ├── loki-gateway (Deployment)       ← nginx entry    │
      │   │                                                    │
      │   ├── tempo-distributor (Deployment)  ← OTel pushes    │
      │   ├── tempo-ingester (StatefulSet)                     │
      │   ├── tempo-querier (Deployment)                       │
      │   ├── tempo-query-frontend (Deployment)                │
      │   ├── tempo-compactor (StatefulSet)                    │
      │   │                                                    │
      │   ├── otel-collector (Deployment × 1) ← app SDK sends  │
      │   │                                                    │
      │   └── alloy (DaemonSet × 1 per node)  ← reads pod logs │
      │                                                        │
      │  monitoring namespace (from Wave 1, extended)          │
      │   └── grafana                                          │
      │        ├── loki datasource (new)                       │
      │        └── tempo datasource (new)                      │
      │                                                        │
      └────────────────────────────────────────────────────────┘

    Data flow (logs):     pod stdout → Alloy → Loki distributor → Loki ingester → MinIO
    Data flow (traces):   app SDK  → OTel Collector → Tempo distributor → Tempo ingester → MinIO
    Query:                Grafana Explore → Loki gateway / Tempo query-frontend → cross-link via exemplars
```

**Namespace strategy:** Single `observability` namespace for the whole stack. NOT bundled into `monitoring` (which is kube-prometheus-stack's namespace) — separating keeps chart Helm-release ownership clean.

**Chart Application pattern (per component):**

- Each of the 4 stacks (Loki, Alloy, Tempo, OTel Collector) gets **its own ArgoCD Application** — split-by-lifecycle matches every other Phase 2-5 install.
- Loki and Tempo need **object-storage credentials from MinIO** (rootUser + rootPassword sourced via a new ExternalSecret) — see below.
- 4 ArgoCD Applications total for Wave 2 compute (`loki`, `alloy`, `tempo`, `otel-collector`), plus 1 for shared credential wiring (`observability-config`).

**Storage credentials:**

- MinIO root credential in Vault at `secret/minio/root` (per ADR-0029)
- New ExternalSecret `observability-storage-credentials` in `observability` namespace, syncing from the same Vault path
- Loki + Tempo chart values reference the resulting k8s Secret via chart's `existingSecret` mechanism (or equivalent)
- **Wave 2 uses MinIO root cred for MVP.** Per-service scoped MinIO credentials (one for Loki, one for Tempo, each with restricted bucket access) are Phase 8 hardening.

**Retention (kind):**

- **Loki:** 7 days (168h). Configured via `limits_config.retention_period`.
- **Tempo:** 3 days (72h). Configured via `compactor.compaction.block_retention`.

**Retention (EKS in Phase 9):** 30-90 days via S3 lifecycle rules. Same chart config, different backend.

**Sample app for trace generation:** Deliberately NOT deployed in this phase. Wave 2's job is to install the pipeline; Phase 6's Node.js golden path template ships with OpenTelemetry SDK wired in and generates real spans. Until then, OTel Collector receives 0 traces — that's fine, the pipeline still validates end-to-end.

## Consequences

- **Positive:** Real observability. `kubectl logs` becomes "one namespace's tail" — Grafana becomes "cluster-wide time-range search." Trace waterfall diagrams for Phase 6+ apps. Cross-linking (metric exemplar → trace → log) is the interview-defining feature.
- **Positive:** All 4 charts follow our established pattern (ArgoCD Application + Helm chart + credentials via ESO). Consistent operational model with everything else.
- **Positive:** Portfolio narrative bundles well — "we run distributed Loki, distributed Tempo, Alloy as the log-shipper standard (not deprecated Promtail), OTel Collector for CNCF-native trace ingest. All backed by S3-compatible storage. Same on kind and EKS."
- **Negative:** ~10-15 new pods, ~2-3 GiB additional memory. Docker Desktop VM at 12 GiB absorbs it; if we later add Mimir (Prometheus long-term storage, Wave 3 candidate), we'd hit 16 GiB.
- **Negative:** Distributed Loki config is genuinely complex — chart values will be dense. First-install debugging surface is nontrivial.
- **Neutral:** Alloy replaces Promtail. Old runbooks + docs referring to Promtail need updates (there aren't any in this repo yet — this is our first log-shipper install).

## Rollout order (per install task)

Charts have soft dependencies via credentials + endpoints. Suggested order:

1. **Task 3.5.3 — Loki + Alloy** (bundled — Alloy needs Loki's endpoint; installing together avoids Alloy failing-then-recovering)
2. **Task 3.5.4 — Tempo** (independent of Loki)
3. **Task 3.5.5 — OTel Collector** (needs Tempo's endpoint)
4. **Task 3.5.6 — Grafana datasource wiring** (needs Loki + Tempo endpoints reachable)

Each task = 1-2 ArgoCD Applications + verification.

## When to revisit

- **When adding a fourth observability signal** (profiling — Pyroscope, exceptions — Sentry). Similar pattern: chart + object storage + Grafana datasource.
- **When kind memory pressure returns.** Distributed Loki + Tempo can be temporarily collapsed to single-binary via `deploymentMode: SingleBinary` chart value — 3-4 pods instead of 10-15, ~500 MiB instead of 2-3 GiB. Trade-off is losing the "prod topology on kind" narrative.
- **When Phase 9 EKS lands.** MinIO Application is deleted, ObjectBucket XRCs replace it, Loki/Tempo endpoints re-point to S3, auth swaps to IRSA. The `observability-storage-credentials` ExternalSecret is replaced by IRSA annotations on the Loki/Tempo ServiceAccounts.
- **When we add Mimir (long-term Prometheus)**. Same LGTM-stack story — chart + object storage. Would replace kube-prometheus-stack's built-in TSDB.
- **When a new Grafana Alloy release adds trace ingest.** Currently Alloy handles logs; OTel Collector handles traces. If Alloy grows to handle both fully, we could collapse OTel Collector out — one shipper agent for logs + traces. Requires Alloy feature-parity, which is not there yet as of 0.7.0.

## Related decisions

- [ADR-0018](0018-external-secrets-install-via-helm.md) — ESO install. `observability-storage-credentials` uses the same pattern.
- [ADR-0020](0020-eso-backend-strategy.md) — Vault-on-kind, Secrets-Manager-on-EKS. Applies to observability creds too.
- [ADR-0023](0023-metrics-server-vs-prometheus.md) — Wave 1 metrics-server discipline. Wave 2 respects the same "don't overlap Prometheus" principle: Loki + Tempo don't scrape metrics of their own; they expose to kube-prometheus-stack via ServiceMonitors (added in this ADR's implementation).
- [ADR-0024](0024-kube-prometheus-stack.md) — Wave 1 observability stack. This ADR is Wave 2, and Grafana (installed in Wave 1) is extended with new datasources.
- [ADR-0025](0025-servicemonitor-strategy.md) — ServiceMonitor strategy. Wave 2's own components will emit metrics via ServiceMonitor per this pattern.
- [ADR-0029](0029-object-storage-strategy.md) — Object storage strategy. This ADR sits on top of the MinIO/S3 abstraction it establishes.

## References

- [Grafana Loki distributed deployment](https://grafana.com/docs/loki/latest/setup/install/helm/install-microservices/)
- [Grafana Alloy migration from Promtail](https://grafana.com/docs/alloy/latest/tasks/migrate/from-promtail/)
- [Grafana Tempo distributed deployment](https://grafana.com/docs/tempo/latest/setup/deployment/#microservices)
- [OpenTelemetry Collector deployment patterns](https://opentelemetry.io/docs/collector/deployment/)
- [LGTM stack overview (Grafana Labs)](https://grafana.com/oss/lgtm/) — Loki + Grafana + Tempo + Mimir

## Interview framing

The one-liner: *"Wave 2 completes the observability triangle. Loki for logs, Tempo for traces, Alloy as the log shipper (Promtail's deprecated replacement), OpenTelemetry Collector for CNCF-standard trace ingest. All 4 in distributed topologies — not single-binary demos — so the config we run on kind is the same shape we'd run on EKS. Storage abstracted via S3 API (MinIO on kind, real S3 on EKS via Phase 4's ObjectBucket XRD). Grafana extended with new datasources for cross-linked drill-downs — click a metric spike in Prometheus, drop into the log line at that timestamp, drop into the trace that logged it. That drill-down flow is the interview-defining feature of a modern observability stack."*
