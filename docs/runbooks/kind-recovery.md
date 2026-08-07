# kind-recovery.md — recovering the local `kind-idp` cluster

Covers four distinct failure modes, ordered from least to most invasive. Read the section matching your symptom; don't do more work than you have to.

## Prerequisites

Before starting any recovery, you need:

- **Docker Desktop running** — kind runs containers inside Docker.
- **`kind`, `kubectl`, `helm`, `argocd`, `gh`** installed (`make check` verifies).
- **Password manager entries** for:
  - `IDP kind ArgoCD — dev credentials` (rotated admin password from Task 2.2.d)
  - `IDP kind Vault — dev credentials` (5 unseal keys + root token from Task 2.4.h, rotated in 2.4.m)

  If either password manager entry is missing, the "safer" recovery paths are closed and you must fall through to the full rebuild (which regenerates all credentials from scratch).

---

## Failure Mode 1: Vault sealed after pod restart or laptop reboot

**By far the most common failure mode.** Every time the Vault pod restarts — including Docker Desktop restart, laptop reboot, `kubectl delete pod`, or the pod being evicted — Vault comes back **sealed**. Deliberate per [ADR-0019](../adr/0019-vault-install-for-eso-kind-backend.md); manual unseal is the training-value trade-off.

### Symptom

Any of:

- `ExternalSecret` objects stuck at `SecretSynced: False, message: "authentication failed"`
- `ClusterSecretStore/vault-kv` status flips to `Ready: False`
- `vault operator generate-root -init` (or any other vault operation) returns `503 Vault is sealed`
- `kubectl get pods -n vault` shows `vault-0` as `0/1` (readiness probe fails on sealed Vault)

### Impact

- **ESO cannot fetch new secrets or refresh existing ones.** Workloads that already have their Secrets materialised continue working; new workloads or refresh-interval-triggered updates fail.
- **Nothing else on the cluster affected.** cert-manager, ExternalDNS, ArgoCD, individual Applications all continue as normal.

### Diagnosis

```bash
kubectl -n vault exec vault-0 -- vault status
```

Confirm: `Sealed: true, Initialized: true`. If `Initialized: false` you're in Failure Mode 4 (full rebuild) instead.

### Remediation

Straight from the password manager. Run 3 times with different unseal keys:

```bash
kubectl -n vault exec -it vault-0 -- vault operator unseal
# Paste one of the 5 unseal keys at each prompt.
# Progress shows 1/3, 2/3, 3/3 → Sealed: false
```

Verify:

```bash
kubectl -n vault exec vault-0 -- vault status
# Sealed: false ← required before ESO can auth
```

**Usually no further action needed.** ESO's next reconcile (default 30s) resumes normal operation.

**BUT** — if ESO's ClusterSecretStore still shows `Ready: False` after ~2 minutes, ESO's reconciler has backed off (exponential backoff up to 5-10 min after several failures). Kick the pod to force an immediate retry:

```bash
kubectl -n external-secrets delete pod -l app.kubernetes.io/name=external-secrets
```

Within ~30s of the fresh pod starting, `ClusterSecretStore/vault-kv` flips back to `Ready: True`. The `external-secrets-stores` Application follows within another 30s.

**Discovered during Phase 4 troubleshooting after a Docker Desktop restart** — updated so future me doesn't wait for a 10-minute backoff timer at 3am when the fix is a 30-second pod kick.

### Prevention

- Long-term: swap to auto-unseal via k8s Secret (documented in [ADR-0019](../adr/0019-vault-install-for-eso-kind-backend.md) — one-line Helm values change). Deferred while manual unseal remains educational.
- Immediate: nothing. Sealed-on-restart is intentional behaviour.

---

## Failure Mode 2: ArgoCD CLI session expired (24h JWT)

### Symptom

Any `argocd` CLI command returns:

```text
level=fatal msg="rpc error: code = Unauthenticated desc = invalid session: token has invalid claims: token is expired"
```

### Impact

- `argocd app sync`, `argocd app list`, `argocd app get` all fail via the CLI.
- **Cluster is unaffected** — reconciliation continues, ArgoCD server is healthy, only your local CLI session expired.

### Diagnosis

Verify the cluster is fine via `kubectl`:

```bash
kubectl get applications -n argocd
```

If this succeeds, cluster is fine. Only the CLI session is stale.

### Remediation

Two options:

**Option A: re-login** (needed if you specifically want to use the argocd CLI):

```bash
# Ensure port-forward is running in another terminal:
make argocd-portforward

# Then in your main terminal:
argocd login localhost:8080 --username admin --insecure
# Paste rotated password from password manager
```

**Option B: use kubectl instead** (faster if you just need to trigger a sync):

```bash
# Force root Application refresh + sync via annotation:
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite
```

`kubectl` uses your kubeconfig's client cert — never expires. Whenever you're being blocked by an expired argocd JWT and just need to poke ArgoCD, this is faster than re-login.

### Prevention

- Long-term: SSO via Dex + GitHub OIDC (Phase 8) — auto-refreshes off your identity provider.
- Immediate: none. 24h JWT is standard.

---

## Failure Mode 3: Single Application stuck OutOfSync or Degraded

### Symptom

`kubectl get applications -n argocd` shows one Application with `SYNC STATUS: OutOfSync` or `HEALTH STATUS: Degraded` that doesn't self-heal.

### Impact

- Depends on the Application. Vault Degraded → ESO breaks. cert-manager Degraded → no cert issuance. Root Degraded → child Applications may become stale.
- Other Applications continue normally.

### Diagnosis

```bash
# See the diff between git and cluster state:
argocd app diff <application-name>

# See detailed status conditions:
kubectl describe application <application-name> -n argocd

# For Health: Degraded, check the underlying pods:
kubectl get pods -n <target-namespace>
kubectl describe pod -n <target-namespace> <pod-name>
```

### Remediation

Ordered from safest to most invasive:

**1. Force refresh + reconcile (most common fix):**

```bash
kubectl -n argocd annotate application <name> argocd.argoproj.io/refresh=hard --overwrite
```

Then wait ~30s and re-check.

**2. Force sync with prune:**

```bash
argocd app sync <name> --prune --force
```

(Needs valid argocd CLI session — see Failure Mode 2 if expired.)

**3. Check for the `omitempty` drift trap.** If the diff shows a field that git has but cluster doesn't, and the field is a boolean `false`, you may be hitting the trap from [ADR-0015 postscript](../adr/0015-argocd-app-of-apps-pattern.md). Fix: remove the explicit `false` from the manifest.

**4. Nuclear option — delete the Application and let root recreate it:**

```bash
# Only for genuinely broken Applications where recreating is safer than debugging:
kubectl delete application <name> -n argocd
# Root will recreate it on next reconcile (~3 min or force with annotation above).
```

### Prevention

- Every ADR postscript documents the failure mode that motivated it. If your Application drift smells familiar, `grep` the ADRs.
- Long-term: automated alerting on Application health via [`argocd-notifications-controller`](../phases/phase-2-platform.md) — Phase 8.

---

## Failure Mode 4: Full cluster rebuild (nuclear option)

### Symptom

Any of:

- `kubectl get pods -A` fails with connection errors
- `kind get clusters` shows nothing (cluster deleted)
- Docker Desktop was reset / kind's storage got corrupted
- You want a truly fresh start (dev-loop exercise, portfolio demo)

### Impact

- **Total data loss on the cluster.** Every PVC is gone, so Vault's storage (containing the unseal state) is wiped, ArgoCD's history is gone, everything.
- No AWS impact — kind is 100% local.
- Recovery time: ~15–20 minutes including Vault re-configuration.

### Diagnosis

```bash
kind get clusters                 # empty = cluster gone
kubectl config current-context    # points at nothing valid, or errors
```

### Remediation

Sequenced. Do them in order.

#### Step 1: Recreate the kind cluster

```bash
make kind-down                    # idempotent — no-op if cluster already gone
make kind-up                      # ~2 min
make kind-status                  # confirm node Ready
```

#### Step 2: Reinstall ArgoCD

```bash
make argocd-install               # ~3 min for chart pull + all pods Ready
make argocd-status                # confirm all argocd pods Running
```

Retrieve + rotate the ArgoCD admin password (Task 2.2.d flow):

```bash
make argocd-password              # prints bootstrap password
```

Then in another terminal:

```bash
make argocd-portforward           # blocking; leave running
```

Then back in main:

```bash
argocd login localhost:8080 --username admin --insecure
# Paste bootstrap password from make argocd-password above

argocd account update-password
# Enter bootstrap password again as current
# Enter a NEW strong password for user admin (2x)
# UPDATE your password manager entry NOW

kubectl -n argocd delete secret argocd-initial-admin-secret
```

#### Step 3: Bootstrap the app-of-apps

```bash
make argocd-bootstrap-root        # applies platform/argocd/root-app.yaml
```

Wait ~5–10 minutes for all child Applications to reconcile. Monitor:

```bash
watch kubectl get applications -n argocd
```

Expect this sequence to appear + become Synced/Healthy:

1. `root` — immediately Synced/Healthy (empty diff — child Apps not yet created)
2. `cert-manager` + `cert-manager-issuers` — ~2 min
3. `external-secrets` + `external-secrets-stores` — ~2 min (SecretStore initially reports Invalid until Vault ready)
4. `vault` + `vault-config` — ~2 min, but **vault-0 pod comes up `0/1` because SEALED** — this is expected and correct
5. `external-dns` — ~1 min

Total: 7 Applications, ~5–10 min after bootstrap-root.

#### Step 4: Re-initialise and re-configure Vault (~10 min)

**All Vault state is gone.** Init, unseal, and reconfigure from scratch. **This will generate new unseal keys and a new root token — you MUST update the password manager entry.**

```bash
# 4a. Init — SAVE THE 5 UNSEAL KEYS AND ROOT TOKEN to your password manager IMMEDIATELY.
# Replace the old entry contents (the old keys don't work on this new cluster).
kubectl -n vault exec -it vault-0 -- vault operator init
```

```bash
# 4b. Unseal (3 times, one key each):
kubectl -n vault exec -it vault-0 -- vault operator unseal
kubectl -n vault exec -it vault-0 -- vault operator unseal
kubectl -n vault exec -it vault-0 -- vault operator unseal

# Verify:
kubectl -n vault exec vault-0 -- vault status
# Should show: Sealed: false, Initialized: true
```

```bash
# 4c. Enter the vault pod shell for the config commands:
kubectl -n vault exec -it vault-0 -- sh
```

Inside the pod:

```sh
# Login as root:
vault login
# Paste new root token from step 4a

# Enable Kubernetes auth method:
vault auth enable kubernetes

# Configure it — reads Vault SA token + CA cert from the pod's own filesystem:
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token

# Enable KV v2 engine at path `secret/`:
vault secrets enable -path=secret -version=2 kv

# Write the eso-reader policy:
cat > /tmp/eso-reader.hcl <<EOF
path "secret/data/*" {
  capabilities = ["read"]
}
EOF
vault policy write eso-reader /tmp/eso-reader.hcl
rm /tmp/eso-reader.hcl

# Create the k8s auth role binding external-secrets SA to eso-reader:
vault write auth/kubernetes/role/eso-reader \
  bound_service_account_names=external-secrets \
  bound_service_account_namespaces=external-secrets \
  policies=eso-reader \
  ttl=1h

# (Optional) Seed a test secret for end-to-end verification:
vault kv put secret/test-secret \
  username=demo-user \
  password=hello-from-vault-2026

# Exit the pod shell:
exit
```

**Note:** the `vault-tokenreview-binding` ClusterRoleBinding is now committed in git (`platform/vault/clusterrolebinding-tokenreview.yaml`) and will be recreated automatically by the `vault-config` ArgoCD Application. No manual `kubectl create clusterrolebinding` needed after Task 2.4.j.

#### Step 5: Verify end-to-end (optional but recommended)

```bash
# ClusterSecretStore should now report Ready: True after Vault is unsealed:
kubectl get clustersecretstore vault-kv
# NAME       AGE   STATUS   CAPABILITIES   READY
# vault-kv   ...   Valid    ReadWrite      True

# Optional: apply the test ExternalSecret from Task 2.4.l to prove the full chain:
kubectl apply -f - <<'EOF'
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: test-from-vault
  namespace: default
spec:
  refreshInterval: 30s
  secretStoreRef:
    name: vault-kv
    kind: ClusterSecretStore
  target:
    name: test-from-vault
    creationPolicy: Owner
  data:
    - secretKey: username
      remoteRef:
        key: test-secret
        property: username
    - secretKey: password
      remoteRef:
        key: test-secret
        property: password
EOF

# Wait ~2s for ESO reconcile, then verify:
sleep 3
kubectl get externalsecret test-from-vault -n default
kubectl get secret test-from-vault -n default -o jsonpath='{.data.password}' | base64 -d
# Expected: hello-from-vault-2026

# Cleanup:
kubectl delete externalsecret test-from-vault -n default
kubectl delete secret test-from-vault -n default
```

**Cluster is fully recovered.**

### Prevention

- The runbook itself is the prevention — every step is documented so future-you can execute mechanically at 3am.
- Long-term Phase 8+: script the Vault re-configuration commands as a `make vault-configure` target so step 4c becomes one command.
- Long-term Phase 8+: auto-unseal via k8s Secret ([ADR-0019](../adr/0019-vault-install-for-eso-kind-backend.md)) removes step 4b from every recovery.

---

## Failure Mode 5: Chart-generated Secret drift after post-install rotation

Any operator where a Helm chart auto-generates a credential Secret on first install (Grafana admin, some Alertmanager receivers, some database operators) can hit this pattern. Grafana is the canonical example.

### Symptom

- ArgoCD Application shows `Synced/Healthy` momentarily, then flips to `OutOfSync/Healthy` on next reconcile
- `argocd app diff <name>` shows drift on 2 resources:
  - The chart-generated `Secret` — a specific field (e.g., `data.admin-password`)
  - A `Deployment` (or StatefulSet) with a `checksum/secret` annotation that follows the Secret
- Even after force-syncing, the drift reappears within one reconcile cycle
- The Application stays `Healthy` throughout (the operator works fine)

### Impact

- **Application-level.** Cosmetic drift indicator, but the underlying workload works.
- **No user-facing impact** if you're using the rotated credential (which lives in the operator's own DB / config), not the Secret.
- **BUT:** if `syncPolicy.automated.selfHeal: true`, ArgoCD will reset the Secret every reconcile — cycling with the chart's re-generation. Grafana's login DB won't be affected (it authenticates against DB, not Secret), but you'll see a lot of noise.

### Diagnosis

```bash
# Which specific resources are OutOfSync?
kubectl -n argocd get application <name> -o json | jq -r '.status.resources[] | select(.status != "Synced") | "\(.kind)/\(.name): \(.status)"'

# What annotations does the Deployment have?
kubectl -n <namespace> get deploy <name> -o jsonpath='{.spec.template.metadata.annotations}' | jq .
```

If you see a chart-generated Secret + a `checksum/*` annotation on the Deployment, this is the pattern.

### Root cause

Helm charts often use `randAlphaNum` or `lookup` functions to generate credentials on first render. When you rotate the credential post-install (via `grafana cli admin reset-admin-password` or equivalent) and delete the field from the Secret for hygiene, the chart's next render sees the field as empty and re-generates a fresh random value. Every render = different value. ArgoCD sees the difference and flags it. If it applies, chart generates again on next render, infinitely.

Grafana specifically: the Deployment has `checksum/secret` annotation set to a hash of the Secret's contents (Helm's way of forcing pod restart when Secret changes). Delete/re-add the admin-password → checksum changes → Deployment shows drift too.

### Remediation

Add `spec.ignoreDifferences` to the ArgoCD Application manifest, targeting the specific fields:

```yaml
spec:
  ignoreDifferences:
    - group: ""
      kind: Secret
      name: <chart-secret-name>
      namespace: <namespace>
      jsonPointers:
        - /data/<field-name>
    - group: apps
      kind: Deployment
      name: <chart-deployment-name>
      namespace: <namespace>
      jsonPointers:
        - /spec/template/metadata/annotations/checksum~1secret
```

Commit + push. **Trigger a ROOT refresh, not the child** — the ignoreDifferences lives in the child Application's spec, which is set by root reconciling the git file. Refreshing the child alone won't pick up the new ignoreDifferences.

```bash
kubectl -n argocd annotate application root argocd.argoproj.io/refresh=hard --overwrite
# wait 30s for root to reconcile
kubectl -n argocd annotate application <child> argocd.argoproj.io/refresh=hard --overwrite
# child now uses the new ignoreDifferences → drift skipped → Synced
```

### Prevention

- **Long-term** (Phase 4+): reference an `ExternalSecret`-managed Secret instead of chart-generated. Chart values usually have an `existingSecret` field for this. ESO reads from Vault (or AWS Secrets Manager on EKS) and materialises the Secret; chart uses that instead of generating its own. Zero drift because the Secret's contents are controlled by the ExternalSecret spec, not the chart's random generator.
- **Short-term**: the `ignoreDifferences` remediation above. Live with the noise until the ESO integration is in place.

### Real occurrence

Hit during Phase 4 troubleshooting on `kube-prometheus-stack` (Grafana admin-password). See commit `df76bfb` for the exact `ignoreDifferences` block applied to `platform/argocd/apps/kube-prometheus-stack.yaml`.

---

## Reference: Expected reconcile times per Application

For monitoring `watch kubectl get applications -n argocd` during a full rebuild (Failure Mode 4):

| Application | Time to Synced/Healthy | Notes |
|---|---|---|
| `root` | Immediate | Empty diff on first reconcile |
| `cert-manager` | ~2 min | Chart pull dominates; 3 pods to schedule |
| `cert-manager-issuers` | ~30s after cert-manager Healthy | Waits for CRDs from cert-manager |
| `external-secrets` | ~2 min | 3 pods (operator + webhook + cert-controller) |
| `external-secrets-stores` | ~30s after ESO Healthy | `ClusterSecretStore` reports `Invalid` until Vault unsealed |
| `vault` | ~2 min | Comes up `0/1` **because sealed** — expected |
| `vault-config` | ~30s | Just a ClusterRoleBinding — trivial |
| `external-dns` | ~1 min | Single pod, straightforward |

**Total: ~5–10 min after `make argocd-bootstrap-root`** for all 7 Applications to reach Synced/Healthy (with Vault caveat about sealed).

Then Vault init + unseal + reconfigure adds another ~10 min (step 4 of Failure Mode 4).

---

## Reference: Command cheat sheet

```bash
# Cluster state
kubectl get pods -A                                     # everything running
kubectl get applications -n argocd                      # ArgoCD app status
make kind-status                                        # kind + node + system pods
make argocd-status                                      # ArgoCD pods + CRDs + secrets

# Force reconcile (works even with expired argocd CLI)
kubectl -n argocd annotate application <name> argocd.argoproj.io/refresh=hard --overwrite

# Vault
kubectl -n vault exec vault-0 -- vault status           # sealed / initialized state
kubectl -n vault exec -it vault-0 -- vault operator unseal   # unseal (3x)
kubectl -n vault exec -it vault-0 -- sh                 # get shell for admin commands

# ArgoCD
make argocd-password                                    # bootstrap password (post-install only)
make argocd-portforward                                 # UI on https://localhost:8080
argocd login localhost:8080 --username admin --insecure # CLI session
argocd account update-password                          # rotate password

# Full nuke and rebuild
make kind-down && make kind-up && make argocd-install && make argocd-bootstrap-root
# Then step 4 of Failure Mode 4 for Vault
```

---

## Related decisions

- [ADR-0015](../adr/0015-argocd-app-of-apps-pattern.md) — app-of-apps pattern (the recursion this runbook restores) + omitempty drift postscript
- [ADR-0017](../adr/0017-cert-manager-issuer-strategy.md) — ClusterIssuer strategy
- [ADR-0019](../adr/0019-vault-install-for-eso-kind-backend.md) — Vault standalone + manual unseal (the reason step 4b exists)
- [ADR-0020](../adr/0020-eso-backend-strategy.md) — ESO backend strategy
- [ADR-0021](../adr/0021-external-dns-install-and-provider-strategy.md) — ExternalDNS inmemory provider
- [ADR-0022](../adr/0022-aws-load-balancer-controller-defer-to-eks.md) — AWS LBC deferred (why there's no 8th Application to wait for on kind)
