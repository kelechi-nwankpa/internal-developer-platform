# platform/observability/

Shared configuration for Phase 3 Wave 2's observability stack — Loki (logs), Tempo (traces), Grafana Alloy (log shipper), OpenTelemetry Collector (trace receiver). Per ADR-0030.

## What's in here

| Path | Purpose |
|---|---|
| [`externalsecret.yaml`](externalsecret.yaml) | Pulls MinIO root credentials from Vault (`secret/minio/root`) into a k8s Secret (`observability-storage-credentials`) in the `observability` namespace. Both Loki and Tempo reference this Secret via `extraEnv` to authenticate against MinIO for chunk/block storage. |

## What's NOT in here

- **Loki / Tempo / Alloy / OTel Collector chart installs.** Each is its own ArgoCD Application under [`platform/argocd/apps/`](../argocd/apps/) — `loki.yaml`, `tempo.yaml`, `alloy.yaml`, `otel-collector.yaml`. Split-by-lifecycle from this config directory (chart bumps vs credential rotation).
- **The MinIO install.** That's [`platform/minio/`](../minio/) (Wave 2 storage — ADR-0029).
- **Grafana datasource wiring.** Extending the Wave 1 Grafana with Loki/Tempo datasources lands in Task 3.5.6 (updates to `platform/argocd/apps/kube-prometheus-stack.yaml`).

## Shared credential strategy (MVP)

Per ADR-0030: **one MinIO root credential shared between Loki and Tempo for MVP.** Per-service scoped MinIO credentials (each with restricted bucket access) is Phase 8 hardening.

Rationale for shared:

- Simpler to reason about at MVP scale
- One ExternalSecret, one k8s Secret, two chart references
- Rotation is a single Vault write + kick both StatefulSets

Rationale for eventually splitting (Phase 8):

- Loki compromised → attacker can also delete Tempo blocks (bad)
- Per-service scoped credentials + MinIO IAM policies restrict blast radius
- Cost is +1 ExternalSecret + 1 Vault path + MinIO CLI setup — modest, but out of Wave 2's scope

## Install order

Handled automatically by ArgoCD sync-waves declared on the Applications:

- **wave -1:** `observability-config` (this directory's ExternalSecret) — ensures Secret exists before chart pods start
- **wave 0:** `loki` (chart)
- **wave 0:** `tempo` (chart, independent of Loki)
- **wave 1:** `alloy` (needs Loki endpoint to push to)
- **wave 1:** `otel-collector` (needs Tempo endpoint to forward to)

Failing to seed the MinIO cred in Vault beforehand → ExternalSecret can't sync → Loki/Tempo pods crash-loop until Vault has the value. ArgoCD retries; self-heals once Vault has it.

## First-install prerequisites

Vault must have `secret/minio/root` populated with `rootUser` + `rootPassword` (done in Task 3.5.2 for MinIO itself — same credential re-used). If for some reason it's missing:

```bash
# Verify the credential exists
kubectl -n vault exec -i vault-0 -- \
  env VAULT_TOKEN="$VAULT_ROOT_TOKEN" \
  vault kv get -mount=secret minio/root
```

If empty, re-seed per [`platform/minio/README.md`](../minio/README.md).

## Credential rotation

Rotating the MinIO root credential affects **MinIO itself + Loki + Tempo simultaneously** (all read from the same Vault path). Sequence:

1. `vault kv put -mount=secret minio/root rootUser=... rootPassword=<new>`
2. Kick ESO: `kubectl -n external-secrets rollout restart deployment/external-secrets`
3. Kick MinIO: `kubectl -n minio rollout restart statefulset/minio` (picks up new env var)
4. Kick Loki + Tempo: `kubectl -n observability rollout restart statefulset/loki-ingester,statefulset/tempo-ingester,deployment/loki-distributor,deployment/tempo-distributor` (all read env var at boot)

Existing chunks/blocks in MinIO stay accessible — the credential authorizes access, not the objects themselves.

## EKS migration (Phase 9)

Per ADR-0029 + ADR-0030:

1. Delete `observability-config` (this Application) — replaced by IRSA annotations on Loki + Tempo ServiceAccounts
2. Delete `minio` and `minio-config` Applications
3. Create `ObjectBucket` XRCs for `loki-chunks` + `tempo-blocks` (via Phase 4 XRD)
4. Update Loki + Tempo `loki.storage.s3.endpoint` + `tempo.storage.trace.s3.endpoint` values from `http://minio.minio.svc:9000` → `https://s3.eu-west-1.amazonaws.com`
5. IRSA replaces static access-key/secret-key auth

## See also

- [ADR-0029](../../docs/adr/0029-object-storage-strategy.md) — object storage strategy
- [ADR-0030](../../docs/adr/0030-observability-wave-2-stack.md) — Wave 2 stack (this ADR)
- [ADR-0018](../../docs/adr/0018-external-secrets-install-via-helm.md) — ESO install pattern
- [platform/minio/README.md](../minio/README.md) — storage layer that this stack depends on
- [docs/runbooks/kind-recovery.md](../../docs/runbooks/kind-recovery.md) FM6 — CRD-defaults drift (relevant when authoring the ExternalSecret in this directory)
