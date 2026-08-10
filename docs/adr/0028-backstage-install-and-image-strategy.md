# 0028 — Install Backstage via official Helm chart, accept `:latest` image as tech debt for Wave 1 MVP

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 5 ships Backstage — the developer portal that turns Phases 1-4's platform + APIs into a click-a-button UI. Two immediate decisions:

1. **How to install?** Helm chart via ArgoCD (established pattern per ADR-0016) is the obvious answer.
2. **Which Backstage image?** This is where the real design tension is. Backstage is fundamentally a Node.js app that every real deployment builds themselves (via `backstage-cli new-app`). The chart's default image (`ghcr.io/backstage/backstage:latest`) is a reference demo — meant for evaluation, not prod.

## Decision drivers

1. **MVP-first pacing.** Wave 1 of Phase 5 aims to prove Backstage works with our platform (catalog integration, Kubernetes plugin, template scaffolder). Custom image work adds ~1-2 sessions of `backstage-cli new-app` + Docker + registry + CI plumbing that would delay MVP validation.
2. **No `:latest` discipline (CLAUDE.md §9).** We've been consistent throughout Phases 1-4: no `:latest` image tags in Kubernetes manifests. Backstage's demo image breaks this pattern.
3. **Real prod pattern signal.** Every enterprise Backstage deployment I've seen uses a custom-built image with pinned versions of the framework + plugins + local config. The chart is designed for this — its `appVersion` field is deliberately empty because the maintainers can't know your image.
4. **Portfolio narrative.** "We know the tech debt exists, we've documented it explicitly, and we've planned when to fix it" beats "we shipped something opaque."

## Options considered

### Option A — Backstage Helm chart with default upstream image (chosen for Wave 1)

Chart `backstage/backstage:2.8.2` + `backstage.image.tag: latest` (chart default). PostgreSQL sub-chart enabled. Guest auth. Ingress off.

- Pros: Zero setup beyond writing the Application manifest. Backstage running in ~10 min after apply. MVP-validation-first: prove catalog + templates + plugins work against our platform before investing in custom image.
- Cons: **Accepts `:latest` image tag** — violates our no-latest rule. Rolls unpredictably on pod restart. Unfit for portfolio-quality claim beyond "MVP working." This is the tech debt we're accepting deliberately.

### Option B — Custom-built Backstage image + Helm chart

Run `backstage-cli new-app` → customize `app-config.yaml` + add plugins → `yarn build:all` → `docker build` → push to GHCR (personal repo) → chart image points at pinned tag.

- Pros: Portfolio-quality — pinned image, our own config, custom plugins possible. Real prod pattern. No `:latest` violation.
- Cons: **~1-2 sessions of setup work** — backstage-cli scaffolding, app-config wrangling, Docker build pipeline, image registry, tag rotation. All before we can test whether Backstage even helps our platform. MVP validation delayed.

### Option C — Roadie (SaaS-hosted Backstage)

- Pros: Zero infrastructure to run.
- Cons: Contradicts the whole "local-first + GitOps + $0 spend" project premise. Not portfolio-authentic. External vendor dependency.

### Option D — Alternative developer portal (Port.io, Cortex, etc.)

- Pros: Different products with different UX. Some are SaaS-only, avoids Backstage's Node.js customization overhead.
- Cons: Backstage is the community standard + open source + on the CNCF landscape. Portfolio value is greater for the recognized standard. Non-Backstage portals are legitimate but portfolio-narrower.

## Decision

**Option A for Wave 1 (MVP install)**, with explicit migration to **Option B in Wave 2 or Phase 8** once the platform-side integration work is validated.

**Chart pin: `2.8.2`.** Latest stable chart (2026-07-30).

**Explicit tech-debt call-out:**

- `backstage.image.tag: latest` in `platform/argocd/apps/backstage.yaml`
- Inline comment in the values block cross-referencing this ADR
- Migration to Option B tracked as a Phase 5 Wave 2 or Phase 8 sub-task
- **This is technical debt, deliberately taken on for MVP pacing, not an oversight.**

## Consequences

- **Positive:** Backstage running in ~10 min after apply. MVP catalog + templates + plugin integration validation possible immediately. Enables all subsequent Wave 1 tasks (5.3 UI verification, 5.4 catalog entities, 5.5 plugin wiring). Zero setup burden beyond writing the Application manifest. Consistent Helm-via-ArgoCD pattern with Phases 2-4.
- **Negative:** `:latest` image rolls unpredictably. Any push to Backstage's demo image could break our install on next pod restart. Not portfolio-quality-defensible beyond MVP. **Migration to custom image is real work** (~1-2 sessions) — deferring it means the portfolio narrative reads as "shipped MVP + tech debt documented" rather than "shipped prod-grade."
- **Neutral:** PostgreSQL sub-chart (bitnami/postgresql) enabled via `postgresql.enabled: true` — chart bundles the DB. Data persists via 2Gi PVC on kind. EKS in Phase 9 would swap for RDS provisioned via our Phase 4 ObjectBucket/PostgresDatabase XRD (nice callback).
- **Neutral:** Ingress off — port-forward for kind. Phase 5 Wave 2 or Phase 8 adds cert-manager + Ingress at `portal.idp.seniormankelz.dev`.

## The `:latest` tech debt — explicit remediation plan

**Migrate to Option B when any of these become true:**

- We add a custom Backstage plugin (needs custom image)
- We want to pin plugin versions (needs custom image)
- We want portfolio-quality "no `:latest`" narrative before demoing to interviewers
- Backstage releases a chart update that supports pinned appVersion (unlikely)

**The migration work (~1-2 sessions):**

1. `backstage-cli new-app` locally → generates `packages/app` + `packages/backend` boilerplate
2. Customize `app-config.yaml` (auth, catalog locations, plugin config)
3. `yarn install && yarn build:all` — validates the app builds locally
4. `docker build -t ghcr.io/kelechi-nwankpa/backstage:v1.0.0 .` — using the Dockerfile Backstage scaffolds
5. `docker push ghcr.io/kelechi-nwankpa/backstage:v1.0.0`
6. Update `platform/argocd/apps/backstage.yaml` values → `image.registry`, `image.repository`, `image.tag` overrides
7. Commit + push → ArgoCD reconciles → real pinned image running

**Post-migration:** the same `platform/argocd/apps/backstage.yaml` file, with three values changed. No structural rework.

## When to revisit

- **When we add our first custom plugin.** Custom image becomes non-optional at that point.
- **When Backstage's Helm chart adds semver `appVersion` support.** Unlikely — the model deliberately delegates image ownership to the deployer.
- **When SSO (GitHub OAuth) lands.** Auth config is Backstage-app-level (not chart-level), so custom image work aligns naturally.
- **Wave 2 / Phase 8 catch-all.** Whenever polish becomes higher-priority than new-feature velocity.

## Related decisions

- [ADR-0011](0011-ecr-immutable-tags-per-domain-repos.md) — established the no-`:latest` discipline for ECR. Backstage's tech debt is a documented exception, not a policy change.
- [ADR-0016](0016-cert-manager-install-via-helm.md) — Helm-via-ArgoCD pattern this install follows.
- [CLAUDE.md §9](../../CLAUDE.md) — "No `:latest` image tags in Kubernetes manifests." Explicit acknowledgment: this Application violates that rule, deliberately, with a migration plan.

## References

- [Backstage getting started (custom app scaffolding)](https://backstage.io/docs/getting-started/)
- [Backstage Helm chart on Artifact Hub](https://artifacthub.io/packages/helm/backstage/backstage)
- [Backstage image versioning discussion (GitHub issue)](https://github.com/backstage/backstage/issues) — the maintainer position on why no official versioned reference image exists
- [Spotify's original Backstage announcement](https://engineering.atspotify.com/2020/03/17/how-we-use-backstage-at-spotify/) — the "2-days-to-30-min" onboarding story that motivates Phase 5

## Interview framing

The one-liner: *"For Phase 5 Wave 1 we accept the Backstage upstream demo image with `:latest` tag as documented tech debt. Custom-built images are the real prod pattern for Backstage (framework + plugins + config are all per-deployment), and doing that setup before validating catalog/template integration would delay MVP by 1-2 sessions. ADR-0028 records the trade-off explicitly with an unambiguous migration path: as soon as we add our first custom plugin (Wave 2 or Phase 8), we run `backstage-cli new-app`, build our own image, and swap 3 values in the Application manifest. `:latest` in a portfolio-quality repo is only defensible if it's flagged, understood, and scheduled to be paid down — that's the whole point of this ADR."*

---

## Postscript (2026-08-07) — the four-attempt debugging arc, and why NODE_ENV was the missing piece

Getting the MVP install actually working required four attempts. Recording them all here so a future contributor doesn't re-derive.

### Attempt 1 — chart default `:latest`

Followed ADR-0028's Option A verbatim: `backstage.image.tag` unset (chart default), auth block minimal.

**Failed on:** frontend crashed at load with `NotImplementedError: No implementation available for apiRef{plugin.notifications.service}`. The `:latest` demo image's frontend bundle references a notifications API that its backend didn't implement in the version they built. Classic `:latest` bit-rot — the tag was fine yesterday.

**Lesson:** even the "documented tech debt" `:latest` isn't stable enough to build against. Pin something.

### Attempt 2 — pin `image.tag: "1.32.0"`

Chose 1.32.0 — a known-internally-consistent Backstage release that predates the notifications-plugin frontend/backend mismatch.

**Failed on:** backend refused to start. Config schema validation error — 1.32.0's schema *requires* a `techdocs` block even if you're not using TechDocs. `:latest` was permissive; 1.32.0 wasn't.

**Lesson:** newer Backstage minor versions tighten schema validation. Every pinned release carries its own minimum-required-config surface.

### Attempt 3 — add minimal `techdocs` block

Added `builder: local`, `publisher.type: local`, `generator.runIn: local` — a local-only stub that satisfies the schema without depending on S3/GCS/Azure.

**Failed on:** backend healthy, pod running, port-forward worked. But every frontend page load returned `403` on `/api/auth/guest/refresh`. The frontend was expecting a session cookie that would have been set by a prior call to `/api/auth/guest/start` — and never made that call. The catalog page rendered as an unauthenticated shell that immediately hit the refresh endpoint and got rejected.

**Root cause (partial):** Backstage v1.30+ dropped implicit guest auth for security. The `auth.environment: development` + `providers.guest: {}` in app-config is *necessary* but not sufficient — the frontend bundle in the demo image doesn't have auto-guest-sign-in wired up in the `App.tsx` build.

### Attempt 4 — Path C: add `NODE_ENV=development` env var

Overrode the chart's default `NODE_ENV=production` via `backstage.extraEnvVars`. This is a Node.js env var (prod-hardening convention), *not* a Backstage config value.

**Worked.** Frontend loaded, catalog page rendered as guest, sidebar populated.

**Why it worked:** the Backstage backend has code paths gated on `process.env.NODE_ENV === 'development'` — dev-only shortcuts that skip stricter session checks, permit looser refresh-without-start flows, and enable auto-guest fallbacks. Setting `NODE_ENV=development` at the container level flipped those gates open. `auth.environment: development` in app-config is a *separate signal* the app config layer reads; both need to align for guest auth on the demo image.

### The takeaway that reinforces the ADR

The Wave 2 custom-built-image migration is even more clearly the right long-term answer than the ADR originally stated. In a custom-built image, we would:

- **Control the frontend bundle** — wire `SignInPage` in `packages/app/src/App.tsx` to auto-sign-in as guest explicitly, no `NODE_ENV` hacks
- **Pin all plugin versions** — no notifications-plugin bit-rot possible
- **Own the config schema surface** — no surprise required blocks in minor version bumps
- **Not depend on `NODE_ENV=development` as a security-relevant gate** — dev-mode gates are for local machines, not for cluster deployments (even kind-clusters that will eventually promote patterns to EKS)

**Path C is a workaround, not a solution.** It's fine for MVP validation (portable across sessions, deterministic, documented) but it's the exact kind of thing a Staff engineer would flag in a real review. The line in the values file that reads `NODE_ENV=development` is a red flag we're leaving in place to keep MVP momentum, and Wave 2 will remove it.

### Updated migration triggers

Add to the existing "when to revisit" list:

- **Immediately when we can spare 1-2 sessions.** The debugging cost of `:latest` + demo-image workarounds has already exceeded the delta of doing Option B properly. What was "1-2 sessions of setup" in the original ADR is closer to break-even now that we've spent a session debugging Path A→B→C.
- **Before demoing to any interviewer.** The `NODE_ENV=development` line in a Kubernetes manifest is the single most quotable "this is not prod-grade" signal in the whole repo. Fix it before it becomes the first thing anyone screenshots.

### Runbook implication

If Backstage stops rendering after a Backstage release or chart bump, first thing to check is whether the `NODE_ENV=development` workaround still works. If a future Backstage release closes those dev-mode gates for security reasons, Path C dies and Wave 2 becomes forced. Not a scheduled migration then — an emergency one.

---

## Postscript (2026-08-10) — ArgoCD plugin deferred to Wave 2

Task 5.5 shipped the Kubernetes plugin (5.5a) and deferred the ArgoCD plugin (5.5b) to Wave 2. This wasn't planned at ADR authoring time; recording the reasoning here so future contributors don't wonder why Wave 1 has one but not the other.

### Why deferred

1. **Wave 1's Path A→B→C→D on the Kubernetes plugin already burned significant session time.** The ArgoCD plugin has an equivalent surface area of demo-image limitations to hit — auth wiring (needs an ArgoCD API token), token injection (needs ESO or a Secret mount), plugin schema (custom-image-territory config), same class of frontend-bundle constraints as guest auth.
2. **ArgoCD state is already accessible via `argocd-server`'s own UI.** Port-forward `svc/argocd-server:443` when needed. Same source of truth. The plugin adds pane-of-glass convenience, not new capability.
3. **The Kubernetes plugin — harder + higher-value — is delivering the "live cluster state per Component" promise already.** ArgoCD-in-Backstage is polish, not core.
4. **Portfolio narrative is stronger with a properly closed-out Wave 1** than with a half-implemented Wave 1 + a half-implemented ArgoCD plugin.

### What Wave 2 will do

Custom-built Backstage image → wire ArgoCD plugin + community `plugin-crossplane` (which handles cluster-scoped CRs) + GitHub OAuth + Software Templates + Scaffolder → all together as one polish pass, one deploy. Estimated 6-10 sessions total. See `docs/phases/phase-5-backstage.md#deferred-to-wave-2--concrete-punch-list` for the full 9-item punch list with triggers + effort estimates.

### Interview framing update

The one-liner from earlier still holds — MVP-first pacing accepted `:latest` and demo-image constraints. The additional line is: *"Wave 1 shipped a working self-catalogued portal with a live Kubernetes ops view. Wave 2 is one custom-image build that unlocks 4-5 features simultaneously (ArgoCD plugin, Crossplane cluster-scoped-CR plugin, OAuth, Scaffolder, TechDocs). That bundling is why we deferred — each feature costs ~1 session on top of the custom image, but the custom image is a one-time ~1-2 session investment."*
