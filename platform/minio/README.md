# platform/minio/

S3-compatible object storage for Phase 3 Wave 2's Loki (chunks) and Tempo (blocks), plus any future Wave-2 Backstage/TechDocs artifact storage. Kind-local; **EKS uses AWS S3** provisioned via our Phase 4 ObjectBucket XRD (per ADR-0029).

## What's in here

Since 8W4.1 (2026-11-20) this directory is the **whole** MinIO install,
synced by the `minio-config` Application. The upstream `minio/minio`
chart was removed: MinIO stopped publishing community images (quay.io
returns 401, Docker Hub repo gone) and the chart hardcodes a
`/bin/sh -ce docker-entrypoint.sh` command that shell-less images can't
run.

| Path | Purpose |
|---|---|
| [`externalsecret.yaml`](externalsecret.yaml) | Pulls MinIO root credentials from Vault (`minio/root`) into the `minio-root-credentials` Secret. |
| [`pvc.yaml`](pvc.yaml) | 10Gi RWO data volume. |
| [`deployment.yaml`](deployment.yaml) | MinIO server, `cgr.dev/chainguard/minio` pinned by digest, nonroot 65532, read-only root filesystem. |
| [`service.yaml`](service.yaml) | `minio:9000` (S3) + `9001` (console). The name/port is a contract with Loki, Tempo and Crossplane. |
| [`bucket-job.yaml`](bucket-job.yaml) | PostSync hook creating `loki-chunks` + `tempo-blocks` with `mc mb --ignore-existing` (idempotent). |

**Upgrading MinIO:** Chainguard's free tier only publishes `latest`, so
resolve the new index digest with
`docker buildx imagetools inspect cgr.dev/chainguard/minio:latest` and
replace it in `deployment.yaml` (same for `minio-client` in
`bucket-job.yaml`).

## What's NOT in here

- **The Vault secret itself.** An out-of-band manual seed (see below);
  it must exist before the ExternalSecret can sync, or MinIO can't start.

## First-install order (one-time)

Vault must have the root credential BEFORE ArgoCD syncs this, or the ExternalSecret has nothing to pull and the MinIO pod can't start.

**Step 1 (manual, one-time) — seed Vault:**

```bash
# Generate a strong random password (or use your own)
MINIO_ROOT_PW=$(openssl rand -base64 24)

# Seed the root credential into Vault at kv/minio/root
kubectl -n vault exec -it vault-0 -- \
  vault kv put kv/minio/root \
    rootUser=minioadmin \
    rootPassword="$MINIO_ROOT_PW"

# Print + save the password somewhere safe (1Password / Keychain / etc.)
echo "MinIO root password: $MINIO_ROOT_PW"
```

Note: keep the password in your password manager. Losing it means re-seeding Vault + restarting MinIO — no data loss (bucket contents persist in the PVC) but the running MinIO pod would need to be reconfigured.

**Step 2 (GitOps) — sync ArgoCD:**

After seeding, `root` app-of-apps picks up `minio-config` on its next reconcile.

## Credential rotation

To rotate the MinIO root password:

1. Generate a new password
2. `vault kv put kv/minio/root rootPassword=<new>` (rootUser unchanged)
3. ESO detects the change on its next refresh (~1h; kick with `kubectl -n external-secrets rollout restart deployment/external-secrets` to force immediately)
4. MinIO pod picks up the new Secret on its next restart — trigger with `kubectl -n minio rollout restart deployment/minio`
5. Existing MinIO service accounts (used by Loki/Tempo — Phase 8 hardening) continue to work; only the root user credential changes

## EKS migration (Phase 9)

Per [ADR-0029](../../docs/adr/0029-object-storage-strategy.md):

1. Delete the `minio-config` Application from ArgoCD
2. Create `ObjectBucket` XRCs for `loki-chunks` + `tempo-blocks` (using our Phase 4 XRD)
3. Update Loki + Tempo endpoint values to `https://s3.eu-west-1.amazonaws.com`
4. Auth swaps from static access-key to IRSA (established pattern from ADR-0009)
5. Delete this whole `platform/minio/` directory

## See also

- [ADR-0029](../../docs/adr/0029-object-storage-strategy.md) — object storage strategy (this ADR)
- [ADR-0018](../../docs/adr/0018-external-secrets-install-via-helm.md) — ESO install pattern
- [ADR-0020](../../docs/adr/0020-eso-backend-strategy.md) — Vault-vs-Secrets-Manager kind/EKS split (same shape)
- [ADR-0027](../../docs/adr/0027-first-xrd-objectbucket.md) — ObjectBucket XRD (the Phase 9 replacement path)
