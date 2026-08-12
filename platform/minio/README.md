# platform/minio/

S3-compatible object storage for Phase 3 Wave 2's Loki (chunks) and Tempo (blocks), plus any future Wave-2 Backstage/TechDocs artifact storage. Kind-local; **EKS uses AWS S3** provisioned via our Phase 4 ObjectBucket XRD (per ADR-0029).

## What's in here

| Path | Purpose |
|---|---|
| [`externalsecret.yaml`](externalsecret.yaml) | ExternalSecret CR pulling MinIO root credentials from Vault (`kv/minio/root`) into a k8s Secret (`minio-root-credentials`). The MinIO chart references that Secret via `existingSecret`. |

## What's NOT in here

- **The MinIO chart install itself.** That's [`platform/argocd/apps/minio.yaml`](../argocd/apps/minio.yaml) — Helm Application pointing at the official `minio/minio` chart.
- **Bucket definitions.** Buckets (`loki-chunks`, `tempo-blocks`) are declared in the chart values via `buckets:`; a Helm hook Job pre-creates them on first install.
- **The Vault secret itself.** That's an out-of-band manual seed (see below) — must exist BEFORE the ExternalSecret can sync, or the chart Application will crash-loop.

## First-install order (one-time)

Vault must have the root credential BEFORE ArgoCD syncs this. Sync waves order the Kubernetes resources correctly (ExternalSecret at wave -1, chart at wave 0), but neither can succeed if Vault has nothing to pull.

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

After seeding, `root` app-of-apps will pick up `minio-config` and `minio` on next reconcile. Sync waves ensure the ExternalSecret + resulting k8s Secret exist before the MinIO chart tries to read them.

## Why split into two Applications

Same split-by-lifecycle pattern as `vault-config` / `vault` (Phase 2), `cert-manager-issuers` / `cert-manager` (Phase 2), and `backstage-rbac` / `backstage` (Phase 5):

- **`minio-config`** lifecycle = credential rotation cadence + Vault path changes. Rare.
- **`minio`** lifecycle = chart version bumps. More frequent.

Coupling them would mean touching credentials on every chart bump. Split, they iterate independently.

## Credential rotation

To rotate the MinIO root password:

1. Generate a new password
2. `vault kv put kv/minio/root rootPassword=<new>` (rootUser unchanged)
3. ESO detects the change on its next refresh (~1h; kick with `kubectl -n external-secrets rollout restart deployment/external-secrets` to force immediately)
4. MinIO pod picks up the new Secret on its next restart — trigger with `kubectl -n minio rollout restart statefulset/minio`
5. Existing MinIO service accounts (used by Loki/Tempo — Phase 8 hardening) continue to work; only the root user credential changes

## EKS migration (Phase 9)

Per [ADR-0029](../../docs/adr/0029-object-storage-strategy.md):

1. Delete this Application's `minio-config` + `minio` from ArgoCD
2. Create `ObjectBucket` XRCs for `loki-chunks` + `tempo-blocks` (using our Phase 4 XRD)
3. Update Loki + Tempo endpoint values to `https://s3.eu-west-1.amazonaws.com`
4. Auth swaps from static access-key to IRSA (established pattern from ADR-0009)
5. Delete this whole `platform/minio/` directory

## See also

- [ADR-0029](../../docs/adr/0029-object-storage-strategy.md) — object storage strategy (this ADR)
- [ADR-0018](../../docs/adr/0018-external-secrets-install-via-helm.md) — ESO install pattern
- [ADR-0020](../../docs/adr/0020-eso-backend-strategy.md) — Vault-vs-Secrets-Manager kind/EKS split (same shape)
- [ADR-0027](../../docs/adr/0027-first-xrd-objectbucket.md) — ObjectBucket XRD (the Phase 9 replacement path)
