# templates/ — golden path scaffolder templates

**Contents:** Backstage [Software Templates](https://backstage.io/docs/features/software-templates/) — the "click to create a new service" experience. Each template is a recipe that turns a form submission into a fully-provisioned, running, observable microservice.

## What lives here

Templates arrive from Phase 6. Planned initial set:

| Template | Ships in | Produces |
|---|---|---|
| `nodejs-service` | Phase 6 | Node.js + Fastify service, healthchecks, Prom metrics, OTel trace hook, Dockerfile, GitHub Actions CI, ArgoCD Application manifest, Backstage catalog entity |
| `python-service` | Phase 6 (extension) | Python + FastAPI equivalent |
| `go-service` | Phase 6 (extension) | Go + chi equivalent |
| `frontend-service` | Phase 10 (stretch) | Next.js on Fargate |

Every template ships with the same **golden path guarantees**:

- Healthcheck endpoints (`/healthz`, `/readyz`) hooked up.
- Structured JSON logging shipping to Loki.
- Prometheus metrics endpoint (`/metrics`) scraped automatically.
- OpenTelemetry SDK initialised, spans exported to Tempo.
- Container built with rootless base image, scanned in CI, signed with cosign, SBOM generated with syft.
- ArgoCD Application manifest committed to the GitOps repo.
- Grafana dashboard auto-created from a template.
- Baseline alerts configured (high error rate, high latency, pod OOM).
- IRSA role scoped to only the AWS resources the service needs.

## Why this is its own directory

Templates are **contracts**. Every service scaffolded from a golden path inherits every guarantee above. A change to a template propagates (via re-scaffold or template migration) to every service that used it.

Because templates are so leveraged, they are the highest-blast-radius artefact in the whole platform. Separating them into their own directory makes it explicit: a PR against `templates/` is *not* a small change. Its `CODEOWNERS` gate is deliberately tighter.

## When this arrives

**Phase 6.** Depends on `platform/` (ArgoCD, observability, security) and `portal/` (Scaffolder plugin) being live first — a template can't scaffold what isn't there to scaffold onto.

## Template structure (once Phase 6 lands)

```text
templates/
├── nodejs-service/
│   ├── template.yaml         # Backstage template descriptor
│   ├── skeleton/             # files copied into the new repo
│   │   ├── src/
│   │   ├── Dockerfile
│   │   ├── .github/workflows/
│   │   ├── k8s/               # ArgoCD-managed manifests
│   │   └── catalog-info.yaml  # Backstage entity
│   └── README.md
```

## Relates to

- `portal/` — Backstage's Scaffolder plugin renders these templates.
- `platform/` — the runtime the scaffolded services deploy onto.
- `docs/adr/` — golden-path decisions (why Fastify, why cosign, why rootless base).
