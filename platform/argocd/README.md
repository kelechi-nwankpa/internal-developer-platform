# platform/argocd/ — the ArgoCD app-of-apps root

**Contents:** the single ArgoCD `Application` that bootstraps GitOps for the entire platform, plus the directory it watches for child Applications.

## What lives here

```text
platform/argocd/
├── README.md          ← you are here
├── root-app.yaml      ← the ONE Application applied manually; starts the recursion
└── apps/              ← every YAML in here becomes a managed Application
    └── .gitkeep       ← keeps the directory in Git until Task 2.3 adds the first real child
```

## The mental model in one sentence

**One `kubectl apply -f root-app.yaml` (ever) → ArgoCD watches `apps/` → every file in `apps/` becomes a managed Application → each Application installs its own component.**

After that, adding a new platform component is a one-file PR. Deleting one is a one-file PR. Everything else is automatic reconciliation.

## How to add a new child Application

Never write to this directory directly on a running cluster with `kubectl apply`. Always go through Git:

1. Create `apps/<component-name>.yaml` following the shape of an ArgoCD `Application` (repo URL, path, destination namespace, sync policy).
2. Commit and push to `main`.
3. Wait up to 3 minutes (or trigger a manual sync in the UI/CLI). The `root` Application detects the new file, applies the child Application to the cluster, and the child Application installs its own resources.
4. Watch the child appear in the UI or via `argocd app list`.

## How to remove a child Application

1. Delete `apps/<component-name>.yaml` from Git.
2. Commit and push. `root.syncPolicy.automated.prune: true` will cascade the delete on next reconcile — both the child Application object *and* everything the child installed on the cluster.

## Bootstrap (one-time)

The root Application itself has to arrive on the cluster somehow. That's the "manual apply" moment:

```bash
make argocd-bootstrap-root
```

or equivalently:

```bash
kubectl apply -f platform/argocd/root-app.yaml
```

This is the ONLY manual `kubectl apply` in the entire platform lifecycle. Everything else is GitOps from here.

## Verifying the recursion is healthy

```bash
argocd app list
# Expected after bootstrap: one entry named `root`, Sync=Synced, Health=Healthy.
# Once children are added, they appear here too.

argocd app get root
# Shows sync status, health status, and every child resource root has spawned.
```

## Why this pattern (vs alternatives)

Full rationale in [`ADR-0015`](../../docs/adr/0015-argocd-app-of-apps-pattern.md). Short version:

- **App-of-apps** (this file) — one root Application, all children declared as YAML files in a Git directory. Right for small-to-medium sets of hand-crafted platform components. Us, right now.
- **ApplicationSet** — templated Application generation from a source. Arriving in Phase 6 alongside the app-of-apps pattern for Backstage-generated services.
- **Helm-of-helms** — a Helm chart whose templates are Application objects. Not adopted; adds abstraction for no immediate benefit.
- **Manual per-app kubectl apply** — defeats the whole point of GitOps. Rejected.

## Relates to

- [`docs/adr/0014-argocd-raw-install-vs-helm.md`](../../docs/adr/0014-argocd-raw-install-vs-helm.md) — how ArgoCD itself got installed (the prerequisite for anything here to work)
- [`docs/adr/0015-argocd-app-of-apps-pattern.md`](../../docs/adr/0015-argocd-app-of-apps-pattern.md) — why app-of-apps over the alternatives
- [`docs/phases/phase-2-platform.md`](../../docs/phases/phase-2-platform.md) — the Phase 2 log where this is documented in context
