# NetworkPolicy manifests

Phase 8 Wave 2 Tasks 8W2.5 + 8W2.6.

Each file in this directory is a NetworkPolicy (or NetworkPolicy +
companion) for one platform namespace. GitOps-managed via the
`network-policies` ArgoCD Application
([`platform/argocd/apps/network-policies.yaml`](../argocd/apps/network-policies.yaml)).

## Strategy — why allow-all first, then narrow

Phase 8 Wave 2 open locked in design decision B:
**"allow-all baseline per namespace, then targeted deny once traffic
is mapped."** Big-bang deny-all + allow-list in one PR breaks the
cluster in subtle ways — a service you forgot the Backstage pod
depends on, a sidecar that quietly polls a cross-namespace Service.
NetworkPolicy debugging is the "no logs, no error, just silent
rejection" class.

### The ratchet

For each namespace we iterate through:

1. **Baseline (8W2.5):** ship an explicit allow-all policy. Behavior
   unchanged from "no policy" — K8s treats both identically — but the
   stance is now declared in Git. Reviewable. Git-blameable.
2. **Observe (8W2.6):** `kubectl get pod`, `kubectl exec` from each
   pod, inventory all the DNS lookups + TCP connections the namespace
   actually makes.
3. **Narrow (8W2.6):** replace allow-all with (a) per-destination
   allow rules for known-good flows, (b) a deny-all default.

The deny-all default per namespace is set via a second NetworkPolicy
(e.g. `default-deny.yaml`) with empty podSelector + no ingress/egress
rules. This denies everything the earlier `allow-*` policies don't
explicitly permit.

## Wave 2 scope — 3 key namespaces

Wave 2 ships baselines for three namespaces where narrowing has the
highest portfolio value:

- **backstage** — the user-facing portal. Narrowed in 8W2.6 as a
  demonstration.
- **argocd** — the control plane's reconciliation engine.
- **observability** — Loki + Tempo + Alloy + the OTel collector.

The other platform namespaces (kyverno, cert-manager, external-secrets,
vault, monitoring, external-dns) stay at implicit allow-all until
Phase 10 polish. Explicit stance there is nice-to-have, not debt-closing.

## Pattern — the two policies per namespace

`<namespace>-allow-all.yaml`: explicit allow-all baseline.

`<namespace>-deny-default.yaml` (added in 8W2.6 when narrowing):
empty-rule default-deny that catches anything not in a targeted
allow rule. Set this LAST, after writing targeted allows, to avoid
a window where the namespace is cut off.

## Next namespaces to add

Phase 10 polish ticket: baselines for kyverno, cert-manager,
external-secrets, vault, monitoring, external-dns. Pattern is
mechanical — copy an existing allow-all, change the namespace, add
to this directory (ArgoCD syncs automatically).
