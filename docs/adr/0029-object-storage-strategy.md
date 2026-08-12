# 0029 — Object storage strategy: MinIO on kind, AWS S3 on EKS

- **Status:** Accepted
- **Date:** 2026-08-12
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 3 Wave 2 introduces the observability triangle's other two legs: **Loki for logs** and **Tempo for traces**. Both write to an object-storage backend — Loki stores **chunks** (compressed log blobs, hours of logs per file), Tempo stores **blocks** (compressed trace groups, minutes of traces per file). At any reasonable retention, this is 5-100+ GiB of storage that grows continuously.

Two questions to decide up-front:

1. **What backend on kind?** kind clusters don't come with S3. We need something the pods can write to.
2. **What backend on EKS?** AWS S3 is obvious, but *how* we provision it matters for the "same manifests, kind for dev + EKS for prod" narrative.

## Decision drivers

1. **Portability across environments.** Loki + Tempo speak the S3 API. If both kind and EKS present an S3-compatible endpoint, our Loki/Tempo config differs only in the endpoint URL + credentials — nothing structural.
2. **Real prod pattern.** Nobody stores Loki chunks on `hostPath` volumes in production. Serious deployments use object storage. Doing the same on kind reinforces the pattern.
3. **Callback to Phase 4.** ADR-0027's `ObjectBucket` XRD provisions S3 buckets from Kubernetes CRs. Phase 9's EKS activation could provision the observability buckets via that XRD — using the platform to bootstrap the platform's observability. Strong portfolio narrative.
4. **Cost.** kind: $0 (MinIO runs in-cluster). EKS: ~$1-5/month for our scale (few GB of chunks + blocks + minimal request volume).
5. **No new tech per environment.** We already established the "kind uses in-cluster X, EKS uses AWS-managed X" pattern in ADR-0020 (ESO backend: Vault vs Secrets Manager). Object storage follows the same shape — one ADR to justify a familiar strategy.

## Options considered

### Option A — MinIO in-cluster on kind; AWS S3 on EKS via Crossplane XRD (chosen)

MinIO runs as a standard Helm-installed StatefulSet on kind (single-node standalone mode). Presents an S3-compatible API at `http://minio.minio.svc.cluster.local:9000`. Backend storage is a PVC (~5-20 GiB on kind).

On EKS (Phase 9), the same Loki/Tempo values are re-rendered pointing at AWS S3 buckets provisioned via our Phase 4 `ObjectBucket` XRD. Credentials come from IRSA rather than a static access key.

- **Pros:** Same API on both environments. Portable Loki/Tempo config. $0 on kind. Uses our own XRD on EKS (portfolio callback). Well-understood ops model (StatefulSet + PVC).
- **Cons:** Extra pod on kind (~200Mi RAM). PVC growth needs to be tracked (Loki chunks accumulate — kind's finite storage means retention is capped at ~7 days).

### Option B — Local PersistentVolumes (rejected)

Loki + Tempo both support "filesystem" backends where they write directly to a mounted volume — no S3 API in the middle.

- **Pros:** Simplest possible. No new pods. Native to k8s.
- **Cons:** Not portable to EKS (would require config rewrite + potentially chart-mode change). Loses the S3-API abstraction. Loses the "portfolio-grade prod pattern" story. Ties us to node-local storage limits.
- **Rejected because:** we lose all Option A's cross-environment portability for a small install-time saving.

### Option C — AWS S3 always (rejected)

Point Loki + Tempo at real S3 buckets from day one, even on kind.

- **Pros:** One backend everywhere. No MinIO pod to run.
- **Cons:** Breaks the $0-on-kind principle. Requires AWS credentials on kind (dev laptops). Every kind rebuild costs S3 API calls (small but non-zero). Contradicts CLAUDE.md §3's cost guardrails.
- **Rejected because:** the whole project premise is local-first, $0-until-Phase-9.

### Option D — Kubernetes-native storage (NFS, hostPath) (rejected)

Same class as Option B, different medium. Doesn't offer S3 API.

- **Rejected because:** same reasons as Option B.

## Decision

**Option A: MinIO on kind, AWS S3 on EKS via ObjectBucket XRD.**

**Chart pin (kind):** `minio/minio` latest stable (~5.4.x as of 2026-08). Standalone mode (single replica, single PVC). Managed via ArgoCD Application `minio` per our GitOps-first principle.

**Chart values highlights (drafted for Task 3.5.2b):**

- `mode: standalone` — one MinIO pod, one PVC. Fine for kind's scale.
- `persistence.size: 10Gi` — enough for ~7 days of Loki chunks + Tempo blocks at platform-only volume.
- `buckets:` — pre-create `loki-chunks` and `tempo-blocks` buckets on first boot.
- Credentials via `existingSecret` referring to a Secret populated by ESO from Vault.

**Credential handling:**

- Root/admin credential stored in Vault at `kv/minio/root` (path convention per Vault KV layout established in Phase 2).
- ESO syncs to a Secret in the `minio` namespace at install time.
- Loki + Tempo get scoped MinIO service-account credentials (later — for MVP they use the root cred; hardening lands in Phase 8).

**EKS activation (Phase 9):**

- Delete MinIO's ArgoCD Application.
- Create `ObjectBucket` XRCs (one per bucket, using our Phase 4 XRD) in the appropriate namespaces.
- Re-point Loki + Tempo endpoint values to `https://s3.eu-west-1.amazonaws.com`.
- Auth via IRSA (already established pattern from ADR-0009).

## Consequences

- **Positive:** Portable observability stack. `helm template` output for Loki + Tempo differs across environments in `s3.endpoint` + `s3.access_key_id` values only — nothing structural. Nice portfolio narrative: "on EKS, the platform provisions its own observability storage via the ObjectBucket XRD we shipped in Phase 4."
- **Positive:** Same install shape as everything else — ArgoCD Application + Helm chart + credentials via ESO. Consistent operational model.
- **Negative:** +1 pod on kind (~200Mi memory). Docker Desktop VM at 12 GiB comfortably absorbs it; further headroom monitored.
- **Negative:** PVC growth needs a policy. On kind, we cap retention (Loki: 7 days; Tempo: 3 days). On EKS, S3 lifecycle rules handle it (Phase 9).
- **Neutral:** MinIO's licensing changed in 2025 (upstream moved to GNU AGPL v3 from Apache 2.0). Fine for our use (single-org, non-redistribution). Worth flagging in the phase log.

## When to revisit

- **When Backstage TechDocs lands (Wave 2 Phase 5).** TechDocs stores generated site bundles in an object backend — same MinIO on kind, same S3 on EKS.
- **When Wave 2 Backstage plugins render binary artifacts** (screenshots, dashboards, exports) — same pattern.
- **When we outgrow kind's storage.** If Loki + Tempo start consuming >30 GiB total, we should either (a) tighten retention, (b) enable MinIO's compression more aggressively, or (c) reconsider running Wave 2 fully on kind.
- **When Phase 9 EKS lands** — the "delete MinIO Application, create ObjectBucket XRCs" migration is the moment to validate the whole abstraction. If it doesn't cleanly swap, this ADR was wrong about the abstraction being tight.

## Related decisions

- [ADR-0020](0020-eso-backend-strategy.md) — ESO backend strategy (Vault vs Secrets Manager). Same kind-vs-EKS shape.
- [ADR-0024](0024-kube-prometheus-stack.md) — Wave 1 observability (Prometheus/Grafana/Alertmanager). This ADR is Wave 2's storage foundation.
- [ADR-0027](0027-first-xrd-objectbucket.md) — ObjectBucket XRD. On EKS, our own XRD provisions observability buckets — the platform bootstraps itself.
- [ADR-0018](0018-external-secrets-install-via-helm.md) — ESO install. MinIO's credentials use the same ESO pattern.

## References

- [MinIO Kubernetes deployment guide](https://min.io/docs/minio/kubernetes/upstream/index.html)
- [Loki storage overview](https://grafana.com/docs/loki/latest/storage/)
- [Tempo storage overview](https://grafana.com/docs/tempo/latest/setup/deployment/)
- [MinIO AGPL v3 licensing FAQ](https://min.io/pricing) — non-redistribution use is unaffected

## Interview framing

The one-liner: *"Loki and Tempo need object storage — 5-100+ GiB of chunks and blocks per environment. Rather than write two configs (filesystem on kind, S3 on EKS), we abstract behind the S3 API: MinIO in-cluster on kind, real S3 on EKS. Same Loki/Tempo config, only the endpoint URL and credentials differ. And on EKS, those buckets are provisioned by the ObjectBucket XRD we shipped in Phase 4 — the platform now provisions its own observability storage. That's the callback that makes the demo click."*
