# Phase 6 — Golden Path Template (Node.js)

- **Status:** ✅ Shipped 2026-10-10. First real service running through the platform end-to-end, observability triangle verified with live service traffic.
- **Started:** 2026-09-15 (ADR-0031)
- **Finished:** 2026-10-10 (observability triangle lit)
- **Duration:** ~4 calendar weeks, 5-6 focused sessions + substantial troubleshooting
- **Total AWS spend:** **$0** (still all on kind)
- **Scope note:** Template built + published, Backstage registered, first instantiation (`platform-hello`) deployed end-to-end. Backstage Scaffolder click-to-create flow discovered to already work (Wave 1 Backstage ships the plugin), but `spec.steps:` left empty pending Phase 5 Wave 2's GitHub integration.

## Business problem

**Phases 1-5 built the runway. Phase 6 was the first plane.**

Everything the platform team shipped through Phases 1-5 was platform-only — ArgoCD, cert-manager, ESO, Crossplane XRDs, kube-prometheus-stack, Loki, Tempo, Backstage. No app had ever touched it. Phase 6 changed that: a Node.js REST service, scaffolded from a golden path template, provisioned its own S3 bucket (via workaround — see tech debt), deployed via ArgoCD, emitted traces to Tempo + logs to Loki, and showed up as a first-class Component in Backstage.

**The mission-statement narrative — *"reduce microservice onboarding from ~2 days to ~10 minutes"* — became a running service with real observability.**

## Target users of this phase

- **App engineers (Phase 6+).** Will clone the template, run `bin/render.sh`, push to a new repo, add an ArgoCD Application manifest, and have a service running with full observability within ~10 minutes.
- **Platform team.** First view of the platform *from the app side*. Every rough edge in the developer experience surfaced here (8 of them — see debugging arc).
- **Portfolio narrative.** Screenshots of Grafana showing real trace waterfalls with real service names, log lines linked to those traces, metric spikes correlated. The observability triangle finally has real data.

## Business value

- **Mission-statement proof point.** Template → running service → observability triangle, all in one day (modulo bugs). Interview-screenshot-ready.
- **Every platform capability proven under real load.** ESO Secret rendering, Crossplane XRC application (even if deferred for reconciliation), cert-manager Certificate issuance, Prometheus scraping, Loki log collection, Tempo trace ingestion, Grafana cross-linked drill-down.
- **Foundation for Phase 7 (CI/CD pipeline).** The template ships with a GitHub Actions placeholder; Phase 7 wires build + push + ArgoCD auto-sync.
- **8 bugs banked = institutional knowledge** — each one an ADR postscript, code comment, runbook entry, or commit message. Future contributors (or future me) don't re-derive.

## Architecture — what runs now

```text
                CLUSTER
    ┌──────────────────────────────────────────────────────────┐
    │                                                          │
    │  platform-hello namespace (first real service)           │
    │   ├── platform-hello (Deployment × 2 pods)               │
    │   │    ├─ Fastify 5 + TypeScript 5.7                     │
    │   │    ├─ OTel SDK → OTLP HTTP → otel-collector          │
    │   │    ├─ pino JSON logs (trace_id injected per line)    │
    │   │    ├─ prom-client /metrics endpoint                  │
    │   │    └─ S3 roundtrip to MinIO bucket (manual Secret)   │
    │   ├── Service (ClusterIP :3000)                          │
    │   ├── ServiceAccount                                     │
    │   ├── ServiceMonitor (Prometheus scrape)                 │
    │   ├── ExternalSecret → platform-hello-config (app vars)  │
    │   ├── platform-hello-bucket-conn Secret (MANUAL, see     │
    │   │   tech debt — Phase 4 Wave 2 unblocks GitOps path)   │
    │   ├── Certificate (SelfSigned ClusterIssuer)             │
    │   └── Ingress (nginx, inert until Phase 8)               │
    │                                                          │
    │  observability namespace (from Phase 3 Wave 2)           │
    │   ├── OTel Collector receives spans from platform-hello  │
    │   ├── Alloy scrapes platform-hello pod stdout            │
    │   └── Grafana derivedField cross-links trace_id ↔ Tempo  │
    │                                                          │
    │  minio namespace                                         │
    │   └── Bucket `platform-hello` (created manually via mc)  │
    │                                                          │
    │  backstage catalog                                       │
    │   ├── kind: Template nodejs-fastify-svc                  │
    │   └── (future) kind: Component platform-hello            │
    │                                                          │
    │  argocd                                                  │
    │   └── Application platform-hello (deploys from the       │
    │       service's own repo on each sync)                   │
    │                                                          │
    │  Service's own git repo + container image                │
    │   ├── github.com/kelechi-nwankpa/platform-hello (public) │
    │   └── ghcr.io/kelechi-nwankpa/platform-hello:v0.1.0      │
    │                                                          │
    └──────────────────────────────────────────────────────────┘
```

## What shipped

| Task | Deliverable | Commits |
|---|---|---|
| **6.1** | ADR-0031 — language + framework + distribution decisions | `2cb666b` |
| **6.2a** | Template chunk 1 — app code + Dockerfile | `cf85548` |
| **6.2b** | Template chunk 2 — K8s manifests + ArgoCD Application | `99cf99e` |
| **6.2c** | Template chunk 3 — template.yaml + render.sh + Makefile | `090949d` |
| **6.2 fixes** | `{{OWNER}}`/`{{GITHUB_ORG}}` split + OTel 1.28 Resource API + XRC schema | `0a92913`, `8412ae9`, `465d968` |
| **6.3** | Register template in Backstage catalog (URL Location) | `bc38577` |
| **6.4a** | Render `platform-hello` locally via `bin/render.sh` | (no commit — local) |
| **6.4b** | git init + push to `github.com/kelechi-nwankpa/platform-hello` | (service repo) |
| **6.4c** | Build + push container to GHCR | (service repo, OTel bug fix `aa3dc3f`) |
| **6.4d** | Seed Vault at `secret/platform-team/platform-hello` | (manual kubectl exec) |
| **6.4e** | Deploy via ArgoCD (add Application manifest to platform repo) | `de32be4` |
| **6.4e fix** | Workaround for missing Crossplane ProviderConfig | `7946035` (platform-hello) |
| **6.4f** | Verify observability triangle with real traffic | `9ebd293` (regex fix) |
| **6.5** | This close-out log + memory + housekeeping | (this commit) |

## The debugging arc — 8 bugs banked as institutional knowledge

### 1. `{{OWNER}}` conflating Backstage team + GitHub org

Template placeholder `{{OWNER}}` was used for BOTH `spec.owner: group:default/{{OWNER}}` (Backstage team: `platform-team`) and `github.com/{{OWNER}}/...` (GitHub org: `kelechi-nwankpa`). First render had `ghcr.io/platform-team/platform-hello:v0.1.0` — wrong.

**Fix:** split into `{{OWNER}}` (team) + `{{GITHUB_ORG}}` (derived in `render.sh` from `--repo-url`). Commit `0a92913`.

### 2. `resourceFromAttributes` doesn't exist in @opentelemetry/resources 1.28

Template's `observability.ts` imported `resourceFromAttributes` + `SEMRESATTRS_SERVICE_NAME` — both exist in OTel JS 2.x, NOT in the pinned 1.28. TypeScript compile failed in Docker build.

**Fix:** use `new Resource({ 'service.name': serviceName })` with literal spec key. Backward-compatible across 1.x. Commits `8412ae9` (template), `aa3dc3f` (service repo).

### 3. GHCR push requires `write:packages` scope

`gh auth login` + `gh auth token | docker login ghcr.io` works for authentication, but the default `gh` token lacks `write:packages` scope. Push rejected with "The token provided does not match expected scopes."

**Fix:** `gh auth refresh --scopes write:packages`. Documented in template README (future) + commit message.

### 4. ObjectBucket XRC schema mismatch

XRD (ADR-0027) wraps user-facing fields under `spec.parameters:` but template XRC had them directly under `spec:`. ArgoCD sync rejected with ".spec.publicRead: field not declared in schema."

**Fix:** wrap `region/publicRead/versioning` under `spec.parameters:` in both template + service. Commits `d898854` + `465d968`.

### 5. Crossplane ProviderConfig for MinIO deferred — manual workaround

ObjectBucket XRC applies cleanly (post-fix 4) and reports `Synced: True, Ready: False`. Underlying Managed Resources (Bucket, BucketVersioning) can't reconcile without a ProviderConfig wired to MinIO on kind. Phase 4 close-out had deferred this.

**Workaround:** created bucket manually via `mc mb local/platform-hello` + created `platform-hello-bucket-conn` Secret with S3 credentials. Removed `ObjectBucket` XRC from service's git. Documented as **Phase 4 Wave 2** TODO. Commit `7946035`.

### 6. Grafana derivedField regex matched wrong format

Original regex `trace_id=(\w+)` matched key=value format (used by some auto-instrumenters), but pino emits JSON: `"trace_id":"<hex>"`. Regex matched 0 log lines; "View Trace" button never rendered.

**Fix:** `'"trace_id"\s*:\s*"([a-fA-F0-9]{16,64})"'` — matches JSON-quoted form. Commit `9ebd293`.

### 7. Grafana datasource provisioning didn't update existing derivedField

Config fix 6 landed in the mounted ConfigMap but Grafana's HTTP API consistently reported `derivedFields: 0`. Rollout restarts didn't help. **Root cause not fully pinned down** — possibilities include provisioning's update semantics on existing rows, a modified-flag in Grafana's DB, or chart's grafana-sidecar logic.

**Recovery that worked:** delete the Grafana PVC → fresh SQLite DB → provisioning runs on empty DB → inserts datasources cleanly with the derivedField. Lost nothing (we had no custom UI state).

**Honest framing:** this is a recovery procedure, NOT a confirmed root cause. If it recurs, worth deeper investigation.

### 8. Grafana admin password drift (recurring)

The ongoing Grafana FM5 pattern — Secret and Grafana's internal DB can drift because the env var `GF_SECURITY_ADMIN_PASSWORD` only seeds the DB at first boot. Any chart re-render overwrites the Secret but DB keeps its original value.

**Fix (same each time):** `grafana cli admin reset-admin-password <value>` + `kubectl apply` the Secret to match. 10-second recovery.

**Permanent fix (deferred to Phase 8):** source admin password from Vault via ESO so both ends have a single source of truth.

## Non-obvious institutional knowledge banked

- **The template's `{{OWNER}}` and `{{GITHUB_ORG}}` are different concepts** — Backstage team ownership vs GitHub organization. Any URL-context field (GHCR image, catalog links, Dockerfile OCI source) needs `{{GITHUB_ORG}}`; team-owned fields (spec.owner, Vault paths, OTel service.namespace) use `{{OWNER}}`.
- **OTel JS semver churn is real** — `@opentelemetry/resources` 1.x vs 2.x has incompatible APIs. Pin precisely + use the lowest-common-denominator API form (literal `new Resource({...})`) to avoid rewrites on bumps.
- **`gh auth login` doesn't request `write:packages` scope.** Push flows need a token refresh with that scope OR a hand-generated PAT.
- **XRD schema wraps user-facing fields under `spec.parameters:`.** XRCs that put fields directly under `spec:` get rejected by ArgoCD's typed-patch check with a cryptic "field not declared in schema" error.
- **Crossplane XRs are empty theatre without a ProviderConfig for the target backend.** Phase 4 shipped the XRD; actual reconciliation on kind needs a MinIO ProviderConfig (Phase 4 Wave 2 TODO).
- **GHCR packages are private by default.** First push → package exists but is unreachable by anonymous pulls. Make public via GitHub UI (Package settings → Danger Zone → Change visibility) OR add an imagePullSecret.
- **Grafana derivedField regex runs against the RAW log line as stored in Loki.** Pretty-printed view in the UI is misleading. Always test regex against single-line JSON output from `curl /loki/api/v1/query_range`.
- **Grafana's derivedField links render in the "Links" section** at the BOTTOM of the expanded log line, not in the Fields sidebar (which shows auto-detected JSON keys).
- **The Backstage Wave 1 demo image ships with the full Scaffolder plugin** (frontend + backend). We assumed it was deferred to Wave 2 — not true. The wizard renders our template's `parameters` schema today. Only `spec.steps:` (actions executed on Create) is empty pending Wave 2 GitHub integration.
- **GHCR Registry API returns 401 on anonymous GET even for public images** — this is standard Docker Registry v2 token-exchange behavior, not an error. Kubelet handles the token exchange automatically.
- **The `ImagePullBackOff → CreateContainerConfigError` transition** means image pulled successfully but envFrom-referenced Secrets don't exist yet. Different problem, different fix path.

## Explicit tech debt (with migration plan)

| Debt | Trigger to fix | Effort |
|---|---|---|
| **Manual MinIO bucket + Secret** instead of GitOps-driven via ObjectBucket XRC | Phase 4 Wave 2 wires Crossplane ProviderConfig for MinIO on kind | 1-2 sessions |
| **Debug exporter still on** in OTel Collector | Phase 6+ when real traces generate enough volume to be noisy | 1-line config change |
| **Image not signed** (no cosign) | Phase 8 image-signing wave | 1 session |
| **GitHub Actions CI placeholder** — no actual builds/pushes/scans | Phase 7 (CI/CD golden pipeline) | 1-2 sessions |
| **Backstage Scaffolder `spec.steps:` empty** — Create button renders form but doesn't actually create repo | Phase 5 Wave 2 (Backstage custom image + GitHub integration) | 1 session once Wave 2 lands |
| **Grafana admin password drift** — Secret ↔ DB can diverge on chart re-render | Phase 8 security hardening — source admin password from Vault via ESO | 1 session |
| **No real ingress** — service only reachable via port-forward | Phase 8 (nginx-ingress install) OR Phase 9 (EKS activation + Route53 + Let's Encrypt) | Phase 8 for kind, Phase 9 for real DNS |

## Deferred to Phase 6 Wave 2 / future phases

| # | Item | Trigger | Phase |
|---|---|---|---|
| 1 | Crossplane ProviderConfig for MinIO (closes bug 5's workaround) | Portfolio polish | Phase 4 Wave 2 |
| 2 | Backstage Scaffolder GitHub integration (makes Create button actually create repo) | When a 2nd template or a real user wants click-to-create | Phase 5 Wave 2 |
| 3 | GitHub Actions CI pipeline (build + push + trivy + cosign + ArgoCD auto-sync) | Second service wants to deploy via GitOps on commit | Phase 7 |
| 4 | Second-language template (Go? Python/FastAPI?) | When a non-Node service is requested | Phase 6 Wave 2 |
| 5 | Backstage `kind: Component` registration for platform-hello | Nice to have — currently we see the Template in catalog but not the running service | 15-min follow-up |
| 6 | Image signing (cosign) + attestation (SLSA) | Phase 8 hardening | Phase 8 |
| 7 | Per-service MinIO scoped credentials | Phase 8 | Phase 8 |
| 8 | Resolve Grafana admin password drift (ESO from Vault) | Portfolio polish | Phase 8 |

## PR-style review

**Strengths:**

- End-to-end mission-statement proven. Template → service → observability triangle. Real data, screenshots-ready.
- 8 bugs = 8 permanent artifacts (commits, ADR postscripts, this phase log). Future contributors land with full context.
- Template is portfolio-polished: distroless container, OTel-first design, structured logging with trace_id, pre-wired ServiceMonitor + ExternalSecret, split-by-lifecycle ArgoCD Application.
- Honest tech-debt accounting — manual MinIO workaround flagged, deferral plan clear, not papered over.
- Backstage Wave 1 Scaffolder discovery was a bonus win we didn't expect.

**Weaknesses (deferred, not blockers):**

- Manual MinIO bucket + Secret breaks GitOps for the storage half of the service. Should land in Phase 4 Wave 2.
- Grafana PVC-nuke recovery is heavy-handed. Root cause of provisioning-not-updating is still a hypothesis.
- No CI pipeline yet — Phase 7 fills this.
- Platform-hello Component entity not registered in Backstage catalog. Service exists in cluster but not in portal (15-min follow-up).
- Debug exporter in OTel Collector will get noisy once more services ship.

## ADRs written this phase

- [ADR-0031](../adr/0031-golden-path-template-nodejs-fastify.md) — Golden path template: Node.js + Fastify + standalone repo + Backstage entity

## Interview talking points

- *"How did you prove the IDP actually works?"* — Phase 6 shipped the first real service through the template. `bin/render.sh` scaffolded it, `git push` + `docker push` + `vault kv put` + commit the ArgoCD Application manifest = running service in ~15 min. Then Grafana shows the full observability triangle lit with real trace data.
- *"Walk me through a bug you found and fixed."* — Pick any of the 8. The `{{OWNER}}` / `{{GITHUB_ORG}}` split is the easiest to explain. The Grafana derivedField regex-vs-format mismatch is the most interesting one (regex worked when I tested it in Python but Grafana showed 0 matches — root cause was provisioning not updating existing datasource).
- *"How do you handle template bugs after the service is already deployed?"* — Two-sided fix: template repo (so future renders are correct) + service repo (so this specific service is correct). Both commits reference each other. 3 bugs in Phase 6 followed this pattern (OTel API, XRC schema, derivedField regex).
- *"What's the trade-off with a kind-only platform?"* — Some capabilities don't work without real cloud. Our Crossplane XRD needed a ProviderConfig wired to MinIO to actually reconcile — we manually-created the bucket + Secret as a workaround and flagged it as Phase 4 Wave 2 TODO. The portfolio story is honest about where the kind demo stops and real AWS begins.
- *"What's the observability triangle drill-down like?"* — Metric spike in Prometheus → click exemplar → Tempo trace waterfall → click a span → Loki log lines at that timestamp filtered by service tags → click `trace_id` in a log line → back to Tempo. Bidirectional. Enabled by `derivedFields` on Loki datasource (regex extracts trace_id) and `tracesToLogsV2` on Tempo datasource.

## LinkedIn post idea

**Hook:** *"Shipped the first real service through my IDP today — 8 bugs along the way, each a portfolio lesson."*

**Body:** Walk through the 8-bug journey, calling out the most illuminating ones:

- `{{OWNER}}` placeholder meant two different things (Backstage team vs GitHub org)
- OTel JS semver churn broke the Docker build on day one
- GHCR auth needs `write:packages` scope that `gh auth login` doesn't request
- Grafana derivedField regex worked in isolation but didn't propagate until I nuked the PVC
- Each bug ends in a commit, ADR postscript, or runbook entry — zero re-derivation cost

**CTA:** link to the phase log + ADR-0031. "This is what 'portfolio-quality' means — not shipping clean, but documenting the mess completely."

## YouTube video idea

**Title:** *"Golden path template → running service → observability triangle in one afternoon (and the 8 bugs I hit)"*

**Structure (20-30 min):**

1. Why golden path templates matter (the "2 days → 10 minutes" story)
2. Template design walkthrough (`skeleton/`, Backstage entity, render.sh)
3. Walkthrough of the 8-bug debugging arc, in order:
    - OWNER vs GITHUB_ORG
    - OTel JS 1.28 API
    - GHCR scopes
    - XRC schema mismatch
    - Crossplane deferred → manual workaround
    - derivedField regex
    - Grafana provisioning not updating
    - Grafana admin password drift
4. End-to-end demo: curl → service pod → Loki + Tempo → cross-link
5. What Phase 7 (CI/CD) adds on top

**Selling point:** unlike most "how I built an IDP" videos (demo of a happy path on a clean cluster), this one shows every real-world rough edge + how to recover.

## Next in project

**Immediate options:**

1. **Phase 7 — CI/CD golden pipeline.** GitHub Actions wiring for the Phase 6 template: build + push + trivy scan + cosign sign + ArgoCD auto-sync on commit. ~3-5 sessions.
2. **Phase 4 Wave 2 — Crossplane ProviderConfig for MinIO.** Closes bug 5's manual workaround. GitOps-complete storage provisioning. ~1-2 sessions.
3. **Phase 5 Wave 2 — Backstage custom image + plugins.** Unlocks Scaffolder click-to-create + ArgoCD/Crossplane plugin UI + Software Templates full flow. ~6-10 sessions.
4. **Phase 8 — Security hardening.** Kyverno + NetworkPolicy + Pod Security Standards + image signing + Grafana admin via Vault/ESO. ~4-6 sessions.
5. **15-min follow-up** — register platform-hello as a `kind: Component` in Backstage catalog. Nice to have.

**Session opener:** *"start Phase 7 CI/CD"* OR *"start Phase 4 Wave 2 MinIO ProviderConfig"* OR *"start Phase 5 Wave 2 Backstage polish"* OR *"start Phase 8 security hardening"*.

## See also

- [ADR-0031](../adr/0031-golden-path-template-nodejs-fastify.md) — template design
- [ADR-0027](../adr/0027-first-xrd-objectbucket.md) — ObjectBucket XRD (the one platform-hello hit the schema mismatch on)
- [ADR-0028](../adr/0028-backstage-install-and-image-strategy.md) — Backstage install (Scaffolder discovery relates here)
- [ADR-0030](../adr/0030-observability-wave-2-stack.md) — observability triangle (the one platform-hello finally lit)
- [templates/nodejs-fastify-svc/README.md](../../templates/nodejs-fastify-svc/README.md) — template usage docs
- [github.com/kelechi-nwankpa/platform-hello](https://github.com/kelechi-nwankpa/platform-hello) — the service repo (the first real service through this IDP)
- [docs/runbooks/kind-recovery.md](../runbooks/kind-recovery.md) — FM5 (Grafana admin drift), and the forthcoming "Grafana derivedField not updating" entry
