# platform/backstage/

Raw Kubernetes manifests that Backstage needs but the Helm chart can't create — currently just RBAC for the in-cluster Kubernetes plugin.

## What's in here

| Path | Purpose |
|---|---|
| [`rbac/clusterrole.yaml`](rbac/clusterrole.yaml) | ClusterRole granting Backstage read access to workload resources + our platform CRDs, so the Kubernetes plugin can render live pod/deployment/CR state on each Component page. |
| [`rbac/clusterrolebinding.yaml`](rbac/clusterrolebinding.yaml) | Binds that ClusterRole to the chart-created `backstage` ServiceAccount in the `backstage` namespace. |

## What is NOT in here

- **The ServiceAccount itself.** The Backstage Helm chart creates it (values: `serviceAccount.create: true`, `serviceAccount.name: backstage`). This directory only adds cluster-scoped RBAC on top.
- **The Backstage app + PostgreSQL install.** That's the Helm chart, deployed by [`platform/argocd/apps/backstage.yaml`](../argocd/apps/backstage.yaml).
- **Catalog entities.** Those live in [`catalog/`](../../catalog/) at the repo root and are fetched by Backstage over HTTP, not synced by ArgoCD.

## Why split from the chart Application?

Same reasoning as `vault-config` / `vault`:

- The chart Application's lifecycle is **chart version bumps** — driven by Backstage release cadence + Helm chart maintainer schedule.
- The RBAC Application's lifecycle is **"which CRDs do we want visible in the plugin"** — driven by our platform's own evolution (adding a new XRD? new provider? new plugin?).

Coupling them would mean touching Helm values every time we add a CRD, and re-testing chart rendering every time we add a permission. Split, they iterate independently.

## Kubernetes plugin ↔ ClusterRole sync

The `kubernetes.customResources` list in [`platform/argocd/apps/backstage.yaml`](../argocd/apps/backstage.yaml) must stay in sync with the CRD groups granted in [`rbac/clusterrole.yaml`](rbac/clusterrole.yaml). If you add a CR to one, add it to the other. The manifest comments in both files cross-reference each other as a reminder.

## Deliberately omitted from the ClusterRole

- **`secrets`.** The plugin can render Secret metadata (names, keys) if granted — but Secret names alone are a real information leak (`postgres-admin-password`, `github-runner-token`, `aws-access-key`), and the plugin degrades gracefully without it. Wave 2 might re-evaluate if we build a plugin that genuinely needs it.
- **`nodes`.** Node-level info is out of scope for a Component-view portal.
- **Any `create` / `update` / `delete` verbs.** Backstage's Kubernetes plugin is strictly read-only; write access would open a large hole (delete a pod from the UI? not for MVP).

## See also

- [`docs/adr/0028-backstage-install-and-image-strategy.md`](../../docs/adr/0028-backstage-install-and-image-strategy.md) — the top-level install ADR (Task 5.2)
- [`docs/phases/phase-5-backstage.md`](../../docs/phases/phase-5-backstage.md) — phase build log
- [Backstage Kubernetes plugin auth reference](https://backstage.io/docs/features/kubernetes/authentication/) — canonical config docs
