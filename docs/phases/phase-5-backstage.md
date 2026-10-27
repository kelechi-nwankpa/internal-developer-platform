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

---

## Phase 5 Wave 2 — Custom Backstage image + GitHub App auth

- **Status:** ✅ Shipped 2026-10-27. Custom Backstage image built via Phase 7 CI pipeline, GitHub App integration live for Scaffolder, platform-hello registered as a Component. Scaffolder template steps + per-plugin wiring deferred to Wave 3 (scoped).
- **Started:** 2026-10-13 (ADR-0028 postscript + strategic intro)
- **Finished:** 2026-10-27 (Backstage pod running on sha-8ed9598 with App auth)
- **Duration:** ~14 calendar days across multiple sessions; interrupted mid-wave by a catastrophic kind-cluster loss during a Docker Desktop upgrade (full cluster rebuild from Git via Option A recovery before resuming)
- **Total AWS spend:** **$0** (still all on kind + GitHub Actions free tier)

## Wave 2 scope — what shipped vs what deferred

**SHIPPED:**

- **Custom Backstage image.** `portal/` scaffold via `@backstage/create-app@latest` with plugins baked in:
  - `@backstage/plugin-scaffolder-backend-module-github` (GitHub Scaffolder actions)
  - `@backstage-community/plugin-argocd` (ArgoCD plugin UI)
  - `@terasky/backstage-plugin-crossplane-{common,resources-frontend,permissions-backend}` (Crossplane plugin)
- **Multi-stage Dockerfile** (`portal/Dockerfile`) that compiles + bundles inside Docker. Replaces the scaffolded "host-build" pattern that required yarn commands on the host before docker build.
- **Phase 7 reusable workflow extended** to support yarn (not just npm), sub-directory apps (not just repo-root), and empty manifest-path (skip the kustomize bump step for Helm-managed services). Backward compatible — platform-hello wrapper unchanged.
- **Portal CI wrapper** (`.github/workflows/portal-ci.yml`) — ~30 lines, invokes the reusable workflow with portal-specific inputs (package-manager: yarn, docker-context: ./portal, manifest-path: "").
- **GitHub App creation + Vault seed.** `kelechi-idp-scaffolder` App (App ID 5311202, Installation 171247580) created in GitHub UI; appId + installationId + clientId + privateKey stored in Vault at `secret/backstage/github-app`.
- **ESO ExternalSecret** materializes the Vault secret into K8s Secret `backstage-github-app` in the backstage namespace. Mounted into Backstage via `extraEnvVarsSecrets`.
- **Helm chart override** flipped from upstream `backstage/backstage:1.32.0` demo image to our custom `ghcr.io/kelechi-nwankpa/internal-developer-platform:sha-8ed9598` image. `appConfig.integrations.github` now configures the real GitHub App.
- **platform-hello Component registered** in Backstage catalog (closes Phase 6 bug 5 follow-up).

**DEFERRED to Phase 5 Wave 3:**

- **5W2.6: Scaffolder template steps.** The `templates/nodejs-fastify-svc/skeleton/` directory uses `{{PLACEHOLDER}}` syntax built for `bin/render.sh` (sed-style substitution). Backstage Scaffolder uses Nunjucks (`${{ values.serviceName }}`). The two template engines are incompatible — converting the whole skeleton is a dedicated wave of work, not a 5W2 tail.
- **5W2.7: Per-plugin wiring.** ArgoCD plugin needs `argocd.baseUrl` + proxy config; Crossplane plugins need `kubernetes.customResources` entries + per-Component annotations. Non-trivial, UI-verification-heavy work. Plugins are INSTALLED in the image but need app-config to activate their UI tiles.

## Business value delivered (Wave 2)

- **Mission statement one step closer.** Custom image = we control the plugin set + versions; no longer dependent on upstream demo image's quirks or random "notifications-plugin api missing" bugs.
- **Supply chain story.** Backstage image goes through the SAME pipeline as platform-hello: multi-arch build → Trivy scan → cosign keyless sign → GHCR push. Any service we ship now has consistent provenance.
- **GitHub App primitive wired.** Scaffolder has credentials; publish:github and catalog:register actions are LOADED and READY (Backstage startup logs confirm). Wave 3 fills the template steps; the plumbing is done.
- **ADR-0028 tech debt closed.** The ":latest / upstream demo image" workaround from Wave 1 is retired. The NODE_ENV=development hack is also gone — custom image handles guest auth properly.
- **platform-hello visible in Backstage.** Component page with tags, links, kubernetes tab, ArgoCD link.

## The debugging arc — 8 bugs banked

### Bug 1 — Docker Desktop out of date (97% disk full)

Before any Portal CI could succeed, local Docker Desktop (v4.13.1 from 2022) needed updating to v4.95 for its "Reclaim disk space" button to free 29 GB back to macOS (from 15 GB free to 44 GB free).

### Bug 2 — Backstage scaffold ships a yarn patch file reference without the patch

`@backstage/create-app@latest` outputs a project that references `got@patch:...` with a `~/.yarn/patches/got-npm-11.8.2-c1eb105458.patch` file that the scaffolder never writes. `yarn install` fails immediately. Fix: `resolutions` override forcing `got: "npm:11.8.5"` — the upstream patch addressed CVE-2022-33987, which 11.8.5 ships natively.

### Bug 3 — Pre-commit hooks tripping on 1700 scaffolded files

Multiple hooks (large-files, gitleaks, EOF-fixer, shebangs) complained about the vendored yarn CLI + lockfile + binary SVGs + Algolia public search keys. Fix: extended `.pre-commit-config.yaml` global exclude for `portal/.yarn/*`, `portal/yarn.lock`, `portal/packages/*/public/*`. Separately needed `.gitleaksignore` with the Algolia key fingerprint because gitleaks ignores the pre-commit global exclude.

### Bug 4 — Scaffolded Dockerfile = host-build pattern (incompatible with Phase 7 CI)

The `packages/backend/Dockerfile` from `create-app` assumes `yarn install && yarn tsc && yarn build:backend` already ran on the HOST before `docker build`. The Phase 7 reusable workflow does none of those; it just runs `docker build`. Fix: wrote a new self-contained multi-stage `portal/Dockerfile` (deps → builder → runtime) that does everything inside docker.

### Bug 5 — Scaffolded .dockerignore excluded source code

The scaffolded `.dockerignore` has `packages/*/src` and `plugins/` on it (tailored for the host-build pattern that only needs dist/). My multi-stage build needs source + plugin workspace dirs. Fix: rewrote `.dockerignore` to only exclude truly build-irrelevant paths (`.git`, `node_modules`, `.yarn/cache`).

### Bug 6 — Trivy's .trivyignore in a subdirectory not found

The reusable workflow's Trivy step didn't set `trivyignores:` input, so Trivy only looked for `.trivyignore` at the repo root (works for platform-hello; fails for portal where the file lives under `portal/`). Fix: added `trivyignores: ${{ inputs.docker-context }}/.trivyignore` to the reusable workflow — parameterised by `docker-context` input so both patterns work.

### Bug 7 — Backstage schema requires clientSecret/webhookSecret as non-empty strings

Set `clientSecret: ""` → "Invalid type ... got empty-string". Removed the fields entirely → "Missing required config value". Backstage 1.44+ `getString()` validator demands these fields be present AND non-empty, even when the auth flow (App JWT) doesn't actually consume them. Fix: literal placeholder strings (`clientSecret: not-used-for-app-jwt-auth`, `webhookSecret: not-used-no-webhooks`). Values are never transmitted to GitHub — they only satisfy the schema.

### Bug 8 — Catastrophic cluster loss mid-wave (Docker Desktop major version upgrade)

The v4.13 → v4.95 Docker Desktop upgrade wiped the entire VM, taking the kind cluster + all 23 ArgoCD apps + Vault data + Backstage Postgres + MinIO buckets with it. Recovered via Option A: `make kind-up` → `make argocd-install` → `make argocd-bootstrap-root` → Vault init + unseal + re-seed secrets. Took ~1 session before being able to resume Wave 2 work. Lesson: **always save Vault keys to an external secret store BEFORE running major Docker Desktop upgrades** (the keys were saved externally, which helps for crash recovery but doesn't help when the storage VOLUME disappears).

### Also encountered (handled quickly, didn't need debugging)

- MinIO vendor policy change — all MinIO images now behind quay.io auth. Deferred (R1 chosen; Phase 4 Wave 2's Crossplane-ObjectBucket workflow stays blocked until Chainguard-style replacement in a separate session).
- Vault k8s auth role name mismatch — created `external-secrets` role, ClusterSecretStore expected `eso-reader`. Fixed with second `vault write auth/kubernetes/role/eso-reader`.

## Non-obvious institutional knowledge banked (Wave 2)

- **Docker Desktop major-version upgrades can wipe the VM.** Not just a reclaim — a full rebuild. Any state in Docker volumes is lost. Treat them like OS upgrades: backup first.
- **The reusable Phase 7 workflow is npm+kustomize-biased by default.** Yarn + sub-directory + Helm-managed services need 3 new inputs (`package-manager`, `docker-context`, `dockerfile-path`) + a `manifest-path != ""` guard on the update-manifest job. All backward-compatible via sensible defaults.
- **Backstage builds are LONG in CI.** 20-25 min on GitHub Actions free runners for the multi-stage build. Portal CI's path filter (`paths: ['portal/**', '.github/workflows/portal-ci.yml', '.github/workflows/reusable-service-ci.yml']`) matters — unrelated commits don't trigger it.
- **Backstage config system merges top-level maps but REPLACES lists.** Helm chart `appConfig.integrations.github[]` fully replaces the baked-in `portal/app-config.yaml` list. For auth configs this is the pattern to use.
- **Backstage 1.44+ `getString()` requires non-empty strings on `clientSecret` + `webhookSecret`** even for App-JWT-only flows that don't use OAuth or webhooks. Literal placeholders satisfy the schema; they're never transmitted.
- **GitHub App auth setup is 10 minutes of GitHub UI clicks + 1 Vault seed.** No OAuth flow needed. App's installation ID + private key is enough for `publish:github` + `catalog:register`.
- **Scaffolder template skeletons must use Nunjucks syntax (`${{ values.X }}`)** not sed-style placeholders. Converting a `bin/render.sh`-oriented skeleton is a separate wave of work.

## ADRs written / updated this wave (Wave 2)

- No new ADRs. Updates to existing:
  - ADR-0028 — "`:latest` image + no custom plugins" tech debt officially closed. Wave 2's custom image + plugin set is now the production path.
  - ADR-0032 (Phase 7 CI pipeline) — reusable workflow extended with 3 new inputs. Documented in-file.

## Interview talking points (Wave 2)

- *"How did you ship a custom Backstage image?"* — Multi-stage Dockerfile (deps → builder → runtime) that does yarn install + yarn tsc + yarn build:backend INSIDE docker, so Phase 7 CI can treat it like any other service. Pushed to GHCR, cosign-signed, and the Helm chart ArgoCD app points at the specific SHA tag.
- *"Why GitHub App over a PAT?"* — Bounded scopes (repo + contents + metadata; no admin), bounded installation (one account), no user-tied token (survives developer offboarding), rotation is a GitHub UI click + Vault re-seed. Scaffolder's publish:github and catalog:register only need the App's short-lived installation token.
- *"Walk me through a non-obvious Backstage startup error."* — Bug 7 (clientSecret/webhookSecret). First attempt: set to `""` → "got empty-string". Second: omit them → "missing required". Third: literal placeholders → works. Backstage's schema requires non-empty strings on fields its auth flow doesn't actually consume. Would never have found this without reading the actual error chain.
- *"What's left on Phase 5?"* — Scaffolder template steps (Wave 3) + per-plugin wiring (Wave 3). The custom image is built, auth is working, plugins are installed — Wave 3 wires them to data. Scoped intentionally to keep each wave shippable.

## Phase 5 Wave 3 roadmap (what Wave 2 explicitly leaves for Wave 3)

**Primary goal of Wave 3:** click-to-create actually works end-to-end — developer clicks Create in Backstage → form submits → GitHub repo scaffolded with real code → ArgoCD syncs → service running.

**Required work:**

1. **Convert `templates/nodejs-fastify-svc/skeleton/` from `{{PLACEHOLDER}}` to `${{ values.X }}` Nunjucks syntax.** Mechanical sed conversion but touches every file. Also updates `bin/render.sh` to understand both OR deprecates it.
2. **Fill `templates/nodejs-fastify-svc/template.yaml` `spec.steps:`** with `fetch:template`, `publish:github`, `catalog:register` actions.
3. **Wire ArgoCD plugin** (`argocd.baseUrl` + proxy config + per-Component `argocd/app-name` annotation).
4. **Wire TeraSky Crossplane plugins** (customResources additions + per-Component annotations for XRCs).
5. **End-to-end smoke test** — click Create in Backstage, fill form, verify new repo + service appear.

**Estimated: 1-2 focused sessions** (template conversion is the biggest chunk; the rest is config edits).

**Not in Wave 3 but worth noting for later:**

- GitHub OAuth sign-in (currently guest auth only) — Phase 8 security hardening
- TechDocs rendering — needs MinIO + storage story
- NetworkPolicies around Backstage pod — Phase 8

## Next in project (post-Wave 2)

**Immediate options:**

1. **Phase 5 Wave 3** — Scaffolder end-to-end + plugin wiring. Natural continuation. 1-2 sessions.
2. **Phase 8** — Security hardening (Kyverno + NetworkPolicy + PSS + ArgoCD drift fix + Chainguard base + action SHA pins + Backstage CVE remediation sweep). ~4-6 sessions.
3. **Phase 9** — EKS promotion (real AWS; the MinIO vendor-policy problem goes away because EKS uses S3 natively).
4. **MinIO rescue** — pick R2 (register for MinIO Subnet account) or R3 (switch to Garage/SeaweedFS/MinIO fork). Unblocks observability + Crossplane bucket provisioning.

**Session opener for Wave 3:** *"start Phase 5 Wave 3, Scaffolder end-to-end."*

## See also (Wave 2)

- Phase 5 Wave 1 content above (unchanged)
- [ADR-0028](../adr/0028-backstage-install-and-image-strategy.md) — install + image strategy (:latest tech debt closed by Wave 2)
- [ADR-0032](../adr/0032-cicd-pipeline-reusable-workflow-oidc-cosign.md) — CI pipeline (extended by Wave 2 for yarn + subdir)
- [portal/README.wave1-notes.md](../../portal/README.wave1-notes.md) — the Phase 0 pre-scaffold README preserved
- [portal/](../../portal/) — the scaffolded Backstage app
