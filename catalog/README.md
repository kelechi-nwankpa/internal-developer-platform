# catalog/

Backstage catalog entities for the IDP platform itself. These files declare *what* the platform is made of, *who* owns it, and *how* it groups together — so the developer portal can render it as a browsable, searchable, linkable catalog.

## What's in here

| File | Entities | Purpose |
|---|---|---|
| [`owners.yaml`](owners.yaml) | `User(kaycee)` + `Group(platform-team)` | The identity model. Every other entity's `spec.owner` points at `platform-team`. |
| [`systems.yaml`](systems.yaml) | `Domain(idp)` + 3 `System`s | The grouping model. Components belong to one System; Systems belong to the top-level Domain. |
| [`components.yaml`](components.yaml) | 14 `Component`s | Every ArgoCD Application on the cluster + ArgoCD itself. Each has `spec.system` linking it into the grouping. |
| [`apis.yaml`](apis.yaml) | 1 `API` | The ObjectBucket XRD (Phase 4). The first infrastructure API this platform offers. Wave 2 / Phase 6 XRDs land here too. |

## How Backstage picks them up

The Backstage `appConfig.catalog.locations` block in [`platform/argocd/apps/backstage.yaml`](../platform/argocd/apps/backstage.yaml) lists each file as a `url` location pointing at `raw.githubusercontent.com`. Backstage's catalog processor polls those URLs on a schedule (~2 min), parses the YAML, and inserts/updates entities in its Postgres store.

**Why raw URLs and not GitHub blob URLs?** Blob URLs require a GitHub integration token (`integrations.github.token` in appConfig) to avoid rate limits. Raw URLs go through the anonymous CDN and work without a token — fine for a public repo, wrong for a private one. When we add the GitHub integration in Wave 2, we can switch to blob URLs and get pretty file-source links in the UI.

## Editing rules

- **Every entity must have `spec.owner`.** No orphans.
- **Every Component must have `spec.system`.** Ungrouped components render as noise.
- **Kinds Backstage will accept from these files are allow-listed** in `appConfig.catalog.rules`. If you add a new kind (e.g. `Resource`, `Template`, `Location`), verify it's in the allow-list.
- **Kebab-case names.** Backstage validates and rejects entities whose names don't match `[a-z0-9]([-a-z0-9]*[a-z0-9])?`.
- **`backstage.io/kubernetes-id`** annotation on each Component matches a K8s label selector — the Kubernetes plugin (Task 5.5) uses it to find pods/deployments per component. Keep it equal to the component name for consistency.
- **`argocd/app-name`** annotation on each Component matches the ArgoCD Application name. Same rule: keep it equal to the component name.

## Not managed here

- **Software Templates** (Phase 6) — those live in [`templates/`](../templates/) and get registered as their own Location.
- **Real microservice catalog entries** (Phase 6+) — those go colocated with the service repo (`services/<svc>/catalog-info.yaml`), not here. This directory is only for the *platform* — the things the platform runs on itself.
- **Sub-tenants / real users / real teams** — MVP has one Group and one User. Real orgs sync from an identity provider (GitHub org, Okta, LDAP) via a Backstage plugin. Out of scope for Wave 1.

## See also

- [`docs/adr/0028-backstage-install-and-image-strategy.md`](../docs/adr/0028-backstage-install-and-image-strategy.md) — why Backstage is installed the way it is, and why the demo image is tech debt
- [`docs/phases/phase-5-backstage.md`](../docs/phases/phase-5-backstage.md) — Phase 5 build log
- [Backstage catalog documentation](https://backstage.io/docs/features/software-catalog/)
