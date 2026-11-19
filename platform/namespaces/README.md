# Namespace labels — Pod Security Standards

Phase 8 Wave 2 Task 8W2.7.

Each file in this directory is a `Namespace` manifest that patches
labels onto an already-existing namespace via ArgoCD + Server-Side
Apply. The namespaces themselves are created by other Applications
(via `CreateNamespace=true`); these manifests only add the
`pod-security.kubernetes.io/*` labels.

## PSS profile choices (per namespace)

Per the Phase 8 Wave 2 open design decision B
(**"case-by-case: restricted where it works, baseline where restricted
breaks something"**):

| Namespace | Profile | Why |
|---|---|---|
| **backstage** | `restricted` | Managed via the Backstage Application's `managedNamespaceMetadata` field (not this dir). Our custom image + Postgres sub-chart both run non-root + without privileged ops. |
| **argocd** | `baseline` | Chart-managed; some components (redis sidecar) have PSS compatibility gaps that aren't worth hand-fixing. Baseline rejects the worst (hostPath, privileged), allows the rest. |
| **observability** | `baseline` | Loki + Tempo + Alloy are chart-managed with variable PSS compliance across versions. Baseline keeps the door open to upgrades without a PSS chase. |

## Why three levels (`enforce` + `audit` + `warn`)

PSS labels can set the profile for enforcement AND for warnings:

- `pod-security.kubernetes.io/enforce` — pods violating the profile
  are REJECTED at admission.
- `pod-security.kubernetes.io/audit` — audit events logged on
  violations; pods still admitted.
- `pod-security.kubernetes.io/warn` — kubectl warning printed on
  apply; pods still admitted.

Setting all three to the SAME profile makes the signal consistent
(no "I warn you about X but don't enforce" confusion). Setting
`audit` or `warn` to a stricter profile than `enforce` gives early
feedback when considering tightening.

## Phase 10 polish rollout

The other platform namespaces (kyverno, cert-manager, external-secrets,
vault, monitoring, external-dns) stay without explicit PSS labels
until Phase 10 polish. Default Kubernetes behavior = `privileged`
profile (allow everything), which is the pre-Wave-2 status quo. Not
debt — just not yet tightened.
