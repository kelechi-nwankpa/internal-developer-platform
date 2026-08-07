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
