# 0031 — Golden path template: Node.js + Fastify + standalone repo + Backstage entity

- **Status:** Accepted
- **Date:** 2026-09-15
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 6 ships the first golden path template — the first real service running end-to-end through the platform Phases 1-5 built. Every choice here compounds: the language + framework will be the reference implementation any future contributor copies, the distribution model will constrain the developer UX until Backstage Wave 2 unlocks the Scaffolder plugin, and the template's shape will define what "using the IDP" means in practice.

Three concerns to decide together (they interact, so one ADR):

1. **Language** — locked by master phase plan to **Node.js**. No decision needed; just note it.
2. **Framework** — Fastify vs Express vs NestJS vs Hono.
3. **Template distribution** — standalone repo, Backstage Software Template entity, or wait for Wave 2 Scaffolder.

## Decision drivers

1. **Portfolio narrative.** The framework choice is one of the first things interviewers scan. "Fastify" signals modern; "Express" signals safe-but-tired; "NestJS" signals enterprise-scale intent; "Hono" signals edge-first. This project's audience is Platform Engineering / Cloud Architect roles — modern-but-pragmatic reads best.
2. **OTel SDK maturity.** Every framework has an OpenTelemetry auto-instrumentation library, but quality varies. Poor auto-instrumentation means the "click a trace, see the full request lifecycle" story falls apart.
3. **Startup time + memory footprint.** kind clusters are memory-constrained (12 GiB total). A framework that spins up in 200ms and holds 40 MiB idle beats one that takes 3s and holds 200 MiB.
4. **Distribution model, MVP.** Backstage Scaffolder (Wave 2 of Phase 5) is deferred. Without it, "click Create in Backstage → new repo" doesn't exist. The template needs a working today-shape that also positions cleanly for the future Scaffolder wire-up.
5. **Every subsequent template inherits this shape.** Whatever we ship in Phase 6 becomes the pattern for a Go template, a Python template, a data-pipeline template, etc.

## Options considered

### Framework choice

#### Option A — Fastify (chosen)

Modern Node.js web framework — schema-first, benchmarks ~10x faster than Express, first-class TypeScript + JSON Schema validation, OpenTelemetry auto-instrumentation by `@opentelemetry/instrumentation-fastify`.

- **Pros:** Fast to start (~200ms cold), tiny memory footprint (~40 MiB idle), schema validation prevents whole classes of bugs, hot in the Node ecosystem (Node.js core team's Undici and Vercel's Serverless Framework both use Fastify or its patterns), OTel instrumentation is well-maintained.
- **Cons:** Fewer StackOverflow hits than Express (a wash — official docs are excellent). Some enterprise codebases still on Express means "why not Express?" question in interviews.

#### Option B — Express (rejected for MVP; would be fallback)

The classic. Every Node dev knows it. `@opentelemetry/instrumentation-express` works.

- **Pros:** Familiar. Zero learning curve for reviewers.
- **Cons:** Slower per-request (async middleware chain), older ergonomics (callback-style patterns leak through), no schema validation without opt-in libraries, ~40% larger memory footprint per instance vs Fastify. Feels dated in a 2026-era portfolio.
- **Rejected because:** portfolio narrative benefits from modern choice; Fastify's OTel story is at parity while everything else is better.

#### Option C — NestJS (rejected)

Angular-inspired, opinionated, decorator-heavy, enterprise-scale.

- **Pros:** Feature-complete out of the box (auth, GraphQL, WebSockets, DI). Real enterprise adoption.
- **Cons:** Very heavy generator output (~30 files for hello-world), longer startup (~3s cold), 200+ MiB idle memory, steep learning curve for anyone not already using it. Overkill for a starter template.
- **Rejected because:** template UX suffers — first `git clone` should show a repo a developer can understand in 5 minutes.

#### Option D — Hono (rejected)

Edge-first framework, ultra-lightweight, targets Workers/Deno/Bun as first-class.

- **Pros:** Smallest possible footprint.
- **Cons:** Designed for edge runtimes; running on Node in Kubernetes leaves half its value on the table. OTel instrumentation less mature. Not the community-standard choice for k8s Node services.
- **Rejected because:** wrong tool for the job — we're deploying to k8s, not the edge.

### Template distribution model

#### Option E — Standalone template repo + registered as Backstage Template entity (chosen)

- Template lives at `templates/nodejs-fastify-svc/` in this repo.
- User workflow (today, without Scaffolder): `git clone` → run `bin/render.sh --name myservice` → new repo scaffolded.
- Same template metadata registered as `kind: Template` in Backstage catalog — shows up in Backstage's Catalog view (with a "Clone template" or "View template repo" link, not a Create button) so it's discoverable.
- When Backstage Wave 2 ships Scaffolder, the entity already exists — Scaffolder just makes the Create button work. No template rewrite.

- **Pros:** Works TODAY. Doesn't wait on Backstage Wave 2. Backstage entity registration is a ~15-line YAML file. Migration path to Scaffolder is trivial (add `spec.steps:` to the entity).
- **Cons:** Developer UX today is manual (`git clone` + `bin/render.sh`), not "click Create." Wave 2 fixes this.

#### Option F — Backstage Software Template only (rejected)

- Only register as `kind: Template` in Backstage catalog.
- Blocked on Scaffolder (Wave 2 of Phase 5, ~6-10 sessions away).

- **Pros:** Simpler, single-source-of-truth in the catalog.
- **Cons:** Nothing works until Scaffolder ships. Phase 6 blocks on Phase 5 Wave 2. Delays the mission-statement narrative validation.
- **Rejected because:** we want to ship Phase 6 now, not defer.

#### Option G — Wait for Backstage Wave 2 (rejected)

- Skip Phase 6. Do Backstage Wave 2 first, then come back.

- **Pros:** Cleanest end-user story.
- **Cons:** Backstage Wave 2 is 6-10 sessions of Node/Docker/Yarn tooling. Phase 6 unblocks Wave 3 of Phase 3 (Prom exemplars need real trace-emitting apps). Doing Phase 6 first is the more valuable next step.
- **Rejected because:** priority ordering — ship a working template today, add clickability in Wave 2 later.

## Decision

**Node.js + Fastify + standalone repo + registered as Backstage Template entity.**

### Language + framework specifics

- **Node.js:** 22 LTS (per project `.nvmrc`)
- **Framework:** Fastify 5.x (latest stable as of 2026-09)
- **TypeScript:** yes — Node ecosystem defaults to it now, better DX + type safety on request/response shapes.
- **Build:** `tsc` → `dist/` → Docker multi-stage `distroless/nodejs22-debian12` base image.
- **Package manager:** npm (built into Node, no separate install step in CI).

### Template file layout (Phase 6 Task 6.2 will create)

```text
templates/nodejs-fastify-svc/
├── README.md                        — how to use this template
├── template.yaml                    — Backstage kind: Template metadata
├── skeleton/                        — files copied verbatim to new repo
│   ├── package.json                 — Fastify + OTel + pino + prom-client
│   ├── tsconfig.json
│   ├── Dockerfile                   — multi-stage distroless build
│   ├── .gitignore
│   ├── src/
│   │   ├── index.ts                 — Fastify server bootstrap
│   │   ├── observability.ts         — OTel SDK setup
│   │   ├── logger.ts                — pino w/ trace_id injection
│   │   └── routes/
│   │       ├── health.ts            — /healthz + /readyz
│   │       └── hello.ts             — example /hello endpoint
│   ├── kubernetes/
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   ├── servicemonitor.yaml      — Prometheus scrape
│   │   ├── externalsecret.yaml      — ESO → Secret w/ app config
│   │   ├── objectbucket.yaml        — Crossplane XRC (per ADR-0027)
│   │   ├── certificate.yaml         — cert-manager Certificate
│   │   ├── ingress.yaml             — nginx-ingress (Phase 8 wires nginx)
│   │   └── kustomization.yaml
│   ├── argocd/
│   │   └── application.yaml         — deployed by commit to platform/argocd/apps/
│   ├── catalog-info.yaml            — Backstage Component entity
│   ├── Makefile                     — dev workflow: `make dev/test/build/docker`
│   └── .github/
│       └── workflows/
│           └── ci.yml               — placeholder for Phase 7
└── bin/
    └── render.sh                    — sed-based renderer (interim, pre-Scaffolder)
```

### Distribution flow (today, pre-Scaffolder)

1. Developer clones this project repo (or eventually a stripped-down templates-only repo).
2. Runs `bin/render.sh --name platform-hello --owner platform-team`.
3. Renderer copies `skeleton/` → new directory, substitutes `{{name}}` / `{{owner}}` placeholders.
4. Developer creates a new git repo for the service, commits, pushes.
5. Developer adds the service's `argocd/application.yaml` to this repo's `platform/argocd/apps/`, commits — service deploys via GitOps.

### Distribution flow (Wave 2 of Phase 5, when Scaffolder lands)

Same `templates/` directory. `template.yaml` gets `spec.steps:` filled in. User clicks Create in Backstage → Scaffolder runs the steps (create repo via GitHub API, commit skeleton, register ArgoCD app). Zero content change to the template's skeleton.

## Consequences

- **Positive:** Modern portfolio narrative (Fastify + TypeScript + OTel + Distroless). Works TODAY without Scaffolder. Clean migration path to Scaffolder when it ships. Every subsequent language template (Go, Python) inherits the "skeleton/ + Backstage Template + ObjectBucket XRC" pattern.
- **Positive:** OTel-first design. When Phase 6 Task 6.4 instantiates `platform-hello`, real spans immediately validate Wave 2's Grafana cross-linking. This unblocks Wave 3 of Phase 3 (Prom exemplars need real apps).
- **Positive:** Distroless image (no shell, no package manager, no libc) — small attack surface. Phase 8 image-signing (cosign) will apply cleanly.
- **Negative:** Adds Node.js + npm to build stack. Existing CI (GitHub Actions in Phase 7) will need Node 22 image + npm cache config.
- **Negative:** TypeScript build step in Docker adds ~30s per build vs plain JS. Trade-off for type safety accepted.
- **Neutral:** Fastify 5.x requires Node 20+; we're on 22 LTS, so fine.

## When to revisit

- **When adding a second language template.** Go template would use similar skeleton pattern; Python (FastAPI) similar. Framework choice for each is a per-language ADR.
- **When Backstage Wave 2 lands.** `template.yaml` gets `spec.steps:` — small edit, no rewrite.
- **When Fastify releases a major version breaking OTel instrumentation.** Rare but possible — pin to major version in package.json to catch.
- **When we adopt a new build tool (Bun, Deno).** Same skeleton would need adaptation. Not planned.
- **When the platform team grows beyond one person.** Solo developer picks the framework they know; a team picks by consensus + operational experience.

## Related decisions

- [ADR-0027](0027-first-xrd-objectbucket.md) — ObjectBucket XRD. Every service instantiated from this template gets one.
- [ADR-0028](0028-backstage-install-and-image-strategy.md) — Backstage install. This template registers as `kind: Template` in the same catalog Wave 1 shipped.
- [ADR-0018](0018-external-secrets-install-via-helm.md) — ESO. Every service uses ESO for app config.
- [ADR-0016](0016-cert-manager-install-via-helm.md) — cert-manager. Every service gets a Certificate (SelfSigned on kind).
- [CLAUDE.md](../../CLAUDE.md) — Node.js 22 LTS locked at project level.

## References

- [Fastify v5 docs](https://fastify.dev/docs/latest/)
- [Distroless Node.js image](https://github.com/GoogleContainerTools/distroless/tree/main/nodejs)
- [OpenTelemetry Node.js auto-instrumentation](https://opentelemetry.io/docs/languages/js/)
- [Pino JSON logger](https://getpino.io/)
- [prom-client (Prometheus metrics for Node.js)](https://github.com/siimon/prom-client)
- [Backstage Software Template schema](https://backstage.io/docs/features/software-templates/)

## Interview framing

The one-liner: *"Phase 6's golden path template is Node.js + Fastify + TypeScript, distroless container, OTel auto-instrumented, structured JSON logs with trace_id injection, Prometheus /metrics endpoint, plus a Crossplane ObjectBucket XRC that provisions an S3 bucket via our own XRD. Every service scaffolded from it shows up in Backstage as a Component and in Grafana with the full observability triangle — traces, logs, metrics all cross-linked from day one. Standalone repo today, clicks in Backstage when Wave 2's Scaffolder ships — same template, no rewrite. This is where the 2-days-to-10-minutes onboarding claim from the mission statement becomes a screenshot."*
