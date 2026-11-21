# Runbook — kind node disk full

Written from the 2026-11-21 incident (Phase 9 log, faults P9-1, P9-2,
P9-6). Every command here was run during that recovery.

## Symptom

Any of:

- Email alert `NodeDiskUsageCritical` (above 90%) or the warning
  `NodeDiskUsageHigh` (above 80%).
- ArgoCD sync errors containing `No space left on device`.
- Pods stuck `ContainerCreating` or `ImagePullBackOff` with disk errors in
  `kubectl describe pod`.

## Impact

At 100% the whole platform degrades within minutes: ArgoCD cannot sync,
Prometheus and Tempo cannot write and corrupt their write-ahead logs, and
new pods cannot start. Running pods keep serving until they restart.

## Why it happens

The kind node is a Docker container on Docker Desktop's VM disk (32 GB).
kind turns off the kubelet's image garbage collection, so every image
ever pulled stays cached. Each image bump (Backstage, platform-hello)
adds to it. Nothing reclaims space automatically.

## Diagnosis

```bash
# How full is the node's disk?
docker exec idp-control-plane df -h /var

# How many images are cached in the node?
docker exec idp-control-plane sh -c 'crictl images -q | wc -l'

# What is Docker itself holding on the Mac side?
docker system df
```

## Remediation

Ordered from safest to most invasive. Re-check `df` after each step and
stop when usage is under 70%.

### 1. Prune unused images inside the node (safe)

Removes only images that no container is using. Running workloads are
not touched; a removed image is pulled again if it is needed later.

```bash
docker exec idp-control-plane crictl rmi --prune
```

On 2026-11-21 this alone took the disk from 100% to 52%.

### 2. Prune Docker's own leftovers on the Mac (safe)

```bash
docker builder prune -f     # build cache
docker image prune -f       # dangling images only
```

Do **not** run `docker system prune --volumes`: the kind node's data is
a Docker volume.

### 3. Remove quarantined directories from earlier repairs (after review)

Repairs below move damaged logs aside instead of deleting them. Once the
component is confirmed healthy they can go:

```bash
docker exec idp-control-plane sh -c 'du -sh /var/local-path-provisioner/*/*suspect* /var/local-path-provisioner/*/*/*suspect* 2>/dev/null'
```

## After the disk is freed: check for collateral damage

A full disk, or the node restart that often follows, leaves four known
after-effects. Check all four.

### A. Vault is sealed (always, after a node restart)

```bash
kubectl -n vault exec vault-0 -- vault status | grep Sealed
```

If `true`: follow [kind-recovery.md, Failure Mode 1](kind-recovery.md).
Until it is unsealed every ExternalSecret is stale.

### B. Prometheus write-ahead log is corrupt

```bash
kubectl -n monitoring logs prometheus-kube-prometheus-stack-prometheus-0 -c prometheus --tail=300 \
  | grep -iE "compaction failed|corruption"
```

If it prints `corruption in segment`: move the log aside and restart.
This loses only the metrics not yet written to a two-hour block (under
two hours of data).

```bash
PV=$(kubectl -n monitoring get pvc -o json | jq -r '.items[] | select(.metadata.name|test("prometheus-kube-prometheus-stack-prometheus-db")) | .spec.volumeName')
P=$(kubectl get pv "$PV" -o jsonpath='{.spec.hostPath.path}{.spec.local.path}')/prometheus-db
D=$(date +%F)
docker exec idp-control-plane sh -c "cd $P && mv wal wal.suspect-$D && mv chunks_head chunks_head.suspect-$D"
kubectl -n monitoring delete pod prometheus-kube-prometheus-stack-prometheus-0
```

Verify: the count of failed compactions stays at 0.

```bash
kubectl get --raw "/api/v1/namespaces/monitoring/services/kube-prometheus-stack-prometheus:9090/proxy/api/v1/query?query=prometheus_tsdb_compactions_failed_total" \
  | jq -r '.data.result[].value[1]'
```

### C. Tempo ingester is crash-looping (out of memory replaying a damaged log)

```bash
kubectl -n observability get pods | grep tempo-ingester
```

If it is restarting: same repair, on Tempo's volume.

```bash
PV=$(kubectl -n observability get pvc data-tempo-ingester-0 -o jsonpath='{.spec.volumeName}')
P=$(kubectl get pv "$PV" -o jsonpath='{.spec.hostPath.path}{.spec.local.path}')
docker exec idp-control-plane sh -c "cd $P && mv wal wal.suspect-$(date +%F)"
kubectl -n observability delete pod tempo-ingester-0
```

### D. ArgoCD shows stale errors

Refresh **only the Applications that show an error**, one at a time:

```bash
kubectl -n argocd annotate application <name> argocd.argoproj.io/refresh=normal --overwrite
```

Never hard-refresh every Application at once. A hard refresh re-renders
Helm charts, and charts that generate random values (the Backstage
Postgres password) get new ones written into their Secrets. See
[kind-recovery.md, Failure Mode 5](kind-recovery.md).

## Root cause investigation

Before pruning, if time allows, record what filled the disk:

```bash
docker exec idp-control-plane sh -c 'crictl images | sort -k4 -h | tail -15'
```

## Prevention

- Alerts `NodeDiskUsageHigh` / `NodeDiskUsageCritical`
  (`platform/monitoring/platform-health-rules.yaml`) give warning at 80%
  and an email at 90%.
- Run remediation step 1 whenever the warning fires. It is safe at any
  time.
- On EKS this failure mode mostly disappears: the kubelet's image garbage
  collection is on by default.
