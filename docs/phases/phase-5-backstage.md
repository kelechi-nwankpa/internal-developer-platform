# Phase 5 — Backstage developer portal (Wave 1)

- **Status:** ✅ Wave 1 shipped (MVP install + catalog + Kubernetes plugin). Wave 2 explicitly deferred with a documented punch list.
- **Started:** 2026-08-07
- **Finished:** 2026-08-10
- **Duration:** ~4 calendar days, 4-5 focused sessions + substantial troubleshooting
- **Total AWS spend:** **$0** (all on kind)
- **Scope note:** Backstage running, self-catalogued (21 entities across 6 kinds), Kubernetes plugin rendering live cluster state per Component page. ArgoCD plugin + custom-built image + GitHub OAuth + Software Templates + Scaffolder + Ingress + TechDocs all deliberately deferred to Wave 2 — see "Deferred" section.

## Business problem

Phases 1-4 built the platform — infrastructure, GitOps, security, observability, and a Kubernetes-native infrastructure API (Crossplane XRDs). Every one of those capabilities was operable via `kubectl` and YAML. Powerful for platform engineers; opaque for app developers.

Phase 5 puts a **portal** in front of it. Backstage turns the platform from "13 ArgoCD Applications you'd need to know exist" into "one clickable page per component with live status." It's the substrate every subsequent developer-facing feature (Software Templates in Phase 6, TechDocs, Scaffolder) is built on.

## Target users of this phase

- **App engineers (Phase 6+).** Browse the catalog to see what's available. Click a Component to see its live pods, restart counts, metrics. Follow links to ADRs. In Phase 6, click "Create" and scaffold a new service.
- **Platform engineers.** Register new components + XRDs as catalog entities. Own the RBAC + plugin config surface. Debug via the same UI the app engineers use.
- **New joiners.** ~10 minutes to grok the platform via the catalog vs ~2 hours reading ADRs + git-log-crawling.
- **Recruiters + interviewers.** Screenshot bait. A working portal with a live-ops view of 14 components is the Phase 5 portfolio moment.

## Business value

- **Onboarding**: a new engineer's day-1 experience becomes "open portal, browse catalog, click into a component, see how it's wired" instead of "clone a monorepo, `find . -name '*.yaml' | xargs grep`."
- **Ownership visibility**: every entity has an `owner` — no orphan components. Real orgs run this pattern at scale (Spotify's original Backstage story).
- **Live-ops surface**: the Kubernetes plugin turns each Component page into a mini-dashboard (pods, deployments, services, CRs, metrics). Wave 2's ArgoCD plugin adds sync-state on top.
- **Foundation for Wave 2 / Phase 6**: Software Templates (Phase 6) render as first-class citizens in the same portal. "Click a button, get a repo + AWS resources" is the whole IDP promise.

## Architecture — what actually runs now

```text
                CLUSTER
    ┌──────────────────────────────────────────────────────────┐
    │                                                          │
    │  backstage namespace                                     │
    │   ├── backstage (Deployment)                             │
    │   │    └─ SA: backstage (cluster-wide read via           │
    │   │       ClusterRole backstage-kubernetes-plugin-reader)│
    │   └── backstage-postgresql-0 (StatefulSet, 2Gi PVC)      │
    │                                                          │
    │  cluster-scoped                                          │
    │   ├── ClusterRole: backstage-kubernetes-plugin-reader    │
    │   │    (get/list/watch on workloads + 8 CRD groups)      │
    │   └── ClusterRoleBinding → backstage:backstage SA        │
    │                                                          │
    │  ArgoCD Applications (2 net-new for Wave 1)              │
    │   ├── backstage       (Helm chart 2.8.2)                 │
    │   └── backstage-rbac  (raw manifests: role + binding)    │
    │                                                          │
    └──────────────────────────────────────────────────────────┘

    catalog/ (in git, fetched by Backstage over HTTP)
      ├── owners.yaml     — User(kaycee) + Group(platform-team)
      ├── systems.yaml    — Domain(idp) + 3 Systems
      ├── components.yaml — 14 Components (one per ArgoCD app + argocd itself)
      └── apis.yaml       — 1 API (ObjectBucket XRD)
```

## What shipped

| Task | Deliverable | Commits |
|---|---|---|
| **5.1** | Backstage install design + ADR-0028 | (drafted pre-session) |
| **5.2** | ArgoCD Application manifest + PostgreSQL sub-chart + guest auth | 7863f5e |
| **5.2.c-fix** | Pin image to 1.32.0 + techdocs block + NODE_ENV=development | 8f32c3c, 6d5baf2, 8149e97 |
| **5.2.d** | ADR-0028 postscript documenting Path A→B→C debugging arc | d14ece5 |
| **5.3** | UI loads verified (catalog page renders as guest) | (verification only) |
| **5.4** | 21 catalog entities across 6 kinds (owners, systems, components, apis) | 88fdce0, 8434e11 |
| **5.5a** | Kubernetes plugin — SA + ClusterRole + label-selector annotations + cluster-scoped-CR fix | 6124d93, 628b0db, 2a1a306, d630eea |
| **5.5b** | ArgoCD plugin — **deferred to Wave 2** (see "Deferred") | — |
| **5.6** | This close-out log + memory + ADR postscript | (this commit) |

## The debugging arc — 9 bugs banked as institutional knowledge

Phase 5 was heavy on troubleshooting. Every one of the below was diagnosed, fixed, and documented as a permanent artifact so the next contributor (or the next me) doesn't re-derive.

**Install saga (5 bugs, in order):**

1. **`:latest` bit-rot.** Chart default `ghcr.io/backstage/backstage:latest` crashed with `NotImplementedError: apiRef{plugin.notifications.service}` — a frontend/backend version mismatch in the demo image built that week. → **Pinned to `1.32.0`.** Captured in [ADR-0028](../adr/0028-backstage-install-and-image-strategy.md) postscript.
2. **Schema-required `techdocs` block.** Backstage 1.32.0's config schema *requires* a `techdocs` block even if you're not using TechDocs. → **Added minimal `builder/publisher/generator: local` stub.**
3. **Guest auth 401 wall.** `providers.guest: {}` + `auth.environment: development` in app-config were necessary but not sufficient — the demo image's frontend bundle doesn't have auto-guest-sign-in wired. Every page load hit `/api/auth/guest/refresh` and got 403. → **Path C: `NODE_ENV=development` env var** unlocks backend-side dev-mode gates. Works but is a workaround; Wave 2 custom image is the real fix.
4. **SSRF `backend.reading.allow`.** Catalog Location URLs pointing at `raw.githubusercontent.com` were rejected with `NotAllowedError` — Backstage's UrlReader is deny-by-default (SSRF protection against cluster metadata exfiltration). → **One-line fix: `backend.reading.allow: - host: raw.githubusercontent.com`.** Wave 2 GitHub integration removes the need.
5. **Cluster-scoped CR plugin limitation.** Backstage's Kubernetes plugin `customResources` code path scopes every API query to the entity's `kubernetes-namespace` annotation. For cluster-scoped CRs (Crossplane XR/XRD/MR, ESO ClusterSecretStore, cert-manager ClusterIssuer), this produces bogus `/namespaces/NS/PLURAL` paths that 404. → **Kept only NAMESPACED CRs in customResources.** Wave 2 community plugins (e.g. `@backstage-community/plugin-crossplane`) handle cluster-scoped resources properly, but require a custom-built image.

**Plugin sync-up (4 additional bugs, continuing the numbering):**

<!-- markdownlint-disable MD029 -->
6. **Missing `resourcequotas` in ClusterRole.** Plugin queries `/api/v1/resourcequotas` on every entity page load; our ClusterRole didn't grant it → 403. Added to core rules.
7. **ESO CRD apiVersion mismatch.** Plugin config specified `v1beta1`; ESO's stored version is `v1`. Endpoint 404'd. Pinned config to `v1`.
8. **kube-prometheus-stack selector too narrow.** `instance=kube-prometheus-stack` matched 4 of 6 pods; alertmanager + prometheus use sub-instance labels. Switched to set-based `instance in (...)`.
9. **Default `backstage.io/kubernetes-id` selector matched zero pods.** Our platform pods use standard Helm labels (`app.kubernetes.io/instance=<name>`), not the Backstage-specific label. Fixed via `backstage.io/kubernetes-label-selector` annotation override per Component (10 components updated).
<!-- markdownlint-enable MD029 -->

**Every bug ended in a permanent artifact:** ADR postscript, code comment, runbook patch, or memory file. Zero re-derivation cost next time.

## Non-obvious institutional knowledge banked

- **Backstage's demo image is for evaluation, not deployment** — even guest-auth-only requires the `NODE_ENV=development` workaround. Any real deployment builds a custom image. [ADR-0028](../adr/0028-backstage-install-and-image-strategy.md) covers this exhaustively.
- **Backstage's UrlReader is deny-by-default (SSRF protection).** Any URL-fetching feature (catalog, scaffolder, techdocs, custom plugins) needs either a configured integration or `backend.reading.allow`. Memory: [backstage-url-reader-ssrf](.../memory/backstage_url_reader_ssrf.md).
- **The Kubernetes plugin's default label selector (`backstage.io/kubernetes-id=<name>`) matches nothing on Helm-installed clusters.** Every Component needs `backstage.io/kubernetes-label-selector` overriding to something like `app.kubernetes.io/instance=<name>`.
- **Cluster-scoped CRs need a Wave 2 community plugin.** Backstage's built-in Kubernetes plugin scopes all custom resource queries to a namespace and 404s on cluster-scoped CRs. Non-obvious; not called out in the plugin docs.
- **Split-by-lifecycle for RBAC vs the chart Application.** Same pattern as `vault-config` / `vault` and `cert-manager-issuers` / `cert-manager` (Phase 2). Chart bumps and RBAC additions iterate independently.
- **Backstage v1.30+ dropped implicit guest auth for security.** Explicit `auth.environment: development` + `providers.guest: {}` is the new opt-in shape.
- **Backstage's chart mounts app-config as `/app/app-config-from-configmap.yaml`** and passes `--config` — not the `.extra.yaml` path most docs mention.
- **Refresh cascade in app-of-apps: root first, then children.** ignoreDifferences and other spec-level changes live in the child spec set by root. Refreshing the child alone won't pick up new spec until root has re-rendered. (Same lesson as Phase 3 Grafana drift.)

## Explicit tech debt (with migration plan)

- **`NODE_ENV=development` on a Kubernetes container** is the single most quotable "this is not prod-grade" signal in the whole repo. Fix trigger: before demoing to any interviewer, or when we add real auth (Wave 2).
- **Demo image `ghcr.io/backstage/backstage:1.32.0`** is pinned but still upstream — we don't control the plugin list, config schema, or auth wiring. Fix trigger: any of {custom plugin, GitHub OAuth, Software Templates, Scaffolder, cluster-scoped-CR visibility} — all of which need custom image work.

Both are covered by [ADR-0028's postscript](../adr/0028-backstage-install-and-image-strategy.md#postscript-2026-08-07--the-four-attempt-debugging-arc-and-why-node_env-was-the-missing-piece) with a 7-step migration plan.

## Deferred to Wave 2 — concrete punch list

Every item below has a **trigger** (when it becomes non-optional) plus a **rough effort** estimate. This is the "what would portfolio-grade v2 look like?" backlog.

| # | Item | Trigger | Effort |
|---|---|---|---|
| 1 | Custom-built Backstage image (via `backstage-cli new-app` + Docker + GHCR) | Any of items 2-7 below | 1-2 sessions |
| 2 | Remove `NODE_ENV=development` workaround; wire proper guest-auto-signin or SSO | Custom image lands | Same session as #1 |
| 3 | GitHub OAuth (or generic OIDC) — replaces guest auth for real users | Item #1 or when we invite a collaborator | 1 session |
| 4 | ArgoCD plugin — live sync-status + revision history on Component pages | Custom image + ArgoCD API token via ESO | 1 session |
| 5 | Community Crossplane plugin (`@backstage-community/plugin-crossplane`) — renders cluster-scoped CRs | Item #1 | 1 session |
| 6 | Software Templates + Scaffolder — "Create Component" button + generated repo via GitHub API | Items #1, #3 (needs OAuth to open PRs) | 2-3 sessions |
| 7 | Ingress + cert-manager Certificate at `portal.idp.seniormankelz.dev` — no more port-forward | EKS activation (Phase 9) OR when demoing publicly | 1 session |
| 8 | TechDocs proper — mkdocs sites per Component, published to S3 or in-cluster | Item #1 + a real doc source | 1-2 sessions |
| 9 | GitHub integration in `integrations.github` — enables blob URLs + rate-limit-free reads | Any of items #4, #6 | Same session as consumer |

**Estimated Wave 2 total:** 6-10 focused sessions. Could be split across multiple calendar weeks.

## Interview talking points

1. **"We took the Backstage demo image as documented tech debt for MVP, then hit five real limitations that reinforced why Wave 2 must build a custom image."** Then walk through Path A→B→C, the SSRF gate, and the cluster-scoped-CR issue.

2. **"The platform catalogs itself"** — 14 Components + 3 Systems + 1 Domain + 1 API + Group + User = 21 entities. The dependency graph renders every relationship (`cert-manager-issuers` dependsOn `cert-manager`, `vault-config` dependsOn `vault`, `crossplane-providers` dependsOn `crossplane`). It's a living map of what Phases 1-4 built.

3. **"Backstage's UrlReader is deny-by-default for SSRF protection — and we learned that the hard way."** Any modern developer portal treats every outbound URL as a potential SSRF vector because catalog URLs are often user-provided. Cluster metadata endpoints (169.254.169.254), internal databases, and other cluster services are one bad Location entry away from exfiltrated IAM credentials. The one-line fix (`backend.reading.allow`) is the correct posture, not a paranoid one.

4. **"Split-by-lifecycle for RBAC vs chart Application"** — the same pattern we established in Phase 2 (`vault-config` / `vault`, `cert-manager-issuers` / `cert-manager`) applies to `backstage-rbac` / `backstage`. Chart bumps don't force RBAC re-testing; adding a CRD to the plugin's visible list doesn't require touching Helm values.

5. **"The Kubernetes plugin has a known limitation with cluster-scoped CRs that isn't in the plugin docs."** We hit it, diagnosed it (`/namespaces/NS/PLURAL` returns 404 for cluster-scoped), documented it, worked around it (kept only namespaced CRs), and planned the fix (community `plugin-crossplane` in Wave 2's custom image). The takeaway: platform tooling has sharp edges, and finding them in a portfolio project earns credibility.

## Recruiter Q&A

**Q: Why Backstage and not something SaaS like Roadie?**
A: Roadie is legitimate but contradicts the "local-first + GitOps + $0 spend" premise. The portfolio value is running the recognized standard (CNCF-tracked) end-to-end.

**Q: Why not go straight to the custom-built image?**
A: MVP validation. Wave 1's goal was to prove the platform *integrates* with Backstage (catalog + K8s plugin) before spending 2 sessions on backstage-cli scaffolding. That MVP-first ordering caught 5 real bugs that shape Wave 2's design — much cheaper to hit them on the demo image than mid-custom-build.

**Q: What's the AWS bill for this phase?**
A: **$0.** Wave 1 runs entirely on kind. Wave 2's Ingress + LetsEncrypt cert would incur ~$0 on EKS (Route53 hosted zone already exists from Phase 1) but that lands in Phase 9's EKS activation, not here.

**Q: Are there any security concerns with what you shipped?**
A: Yes, all documented. (1) Guest auth is anonymous — anyone on localhost can view the catalog. Wave 1 is single-user on kind; Wave 2's OAuth fixes it. (2) `NODE_ENV=development` on a container is a dev-mode signal that shouldn't be in prod. Wave 2's custom image removes it. (3) ClusterRole grants cluster-wide read on many resource kinds (excluding secrets, deliberately). Real prod would namespace-scope where possible.

## LinkedIn post idea

**Hook:** "The Backstage tutorials skip 5 real problems you'll hit on day one. Here's what I learned building an MVP developer portal in 4 sessions."

**Body:** short recap of the debugging arc — `:latest` bit-rot, schema-required techdocs, guest-auth 401, SSRF UrlReader, cluster-scoped CR limitation. Each one banked as an ADR postscript or memory file.

**CTA:** link to repo + the specific commit for each fix. "Every workaround is in a comment. Every trade-off is in an ADR. No hidden state."

## YouTube video idea

**Title:** "Backstage on kind — everything the getting-started guide skips"

**Structure (15-20 min):**

1. Why we chose Backstage + the `:latest` tech debt trade-off
2. Live debug session: the guest auth 401 wall → NODE_ENV=development
3. Self-cataloguing the platform (21 entities across 6 kinds)
4. Wiring the Kubernetes plugin (SA + RBAC + label-selector annotation gotcha)
5. The cluster-scoped CR limitation — why some things need Wave 2
6. Screenshot walkthrough of the final portal
7. Wave 2 preview: custom image, ArgoCD plugin, Scaffolder

**Selling point:** unlike most Backstage videos (which show a green-field install on a laptop), this one shows integrating with an existing platform + all the gotchas.

## Next in project

**Immediate options:**

1. **Wave 2 (Backstage polish)** — 6-10 sessions. Custom image, OAuth, ArgoCD plugin, cluster-scoped-CR plugin, Scaffolder, TechDocs, Ingress.
2. **Phase 6 (Golden Path Templates)** — with catalog + kubernetes plugin working, we could write our first Software Template even without Scaffolder (the template YAML can live in catalog/ and be manually rendered). Would demonstrate the templates-as-catalog-entities pattern before Wave 2's Scaffolder makes it clickable.
3. **Phase 8 (Observability wave 2)** — Loki + Tempo. Backstage plugins for logs + traces per Component page would light up on Wave 2's custom image.

**Session opener for whichever we pick:** *"start Phase 5 Wave 2"*, *"start Phase 6 golden paths"*, or *"start Phase 8 logs + traces."*

## See also

- [ADR-0028](../adr/0028-backstage-install-and-image-strategy.md) — install + image strategy + the 4-attempt debugging arc
- [platform/backstage/README.md](../../platform/backstage/README.md) — RBAC layout + deliberate omissions
- [catalog/README.md](../../catalog/README.md) — catalog file layout + editing rules
- [Backstage Kubernetes plugin auth docs](https://backstage.io/docs/features/kubernetes/authentication/) — canonical reference for what we wired
