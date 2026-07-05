# Internal Developer Platform (IDP)

> Self-service platform that turns "provision a new production-ready microservice" from a 2-day ticket into a 10-minute form.

![status](https://img.shields.io/badge/status-in%20development-orange)
![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-22-brightgreen)
![aws](https://img.shields.io/badge/cloud-AWS-orange)
![kubernetes](https://img.shields.io/badge/runtime-Kubernetes-326CE5)

---

## The problem

In fast-growing engineering orgs, standing up a new microservice takes **1–3 days of platform-team toil per service**: repo bootstrap, cloud infra, Kubernetes namespace, CI/CD, DNS, TLS, database, secrets, dashboards. Every setup is a snowflake, security controls drift, and the platform team becomes the bottleneck.

## The solution

A **developer portal** ([Backstage](https://backstage.io)) backed by a **GitOps-driven Kubernetes platform** ([Amazon EKS](https://aws.amazon.com/eks/) + [ArgoCD](https://argo-cd.readthedocs.io/) + [Crossplane](https://www.crossplane.io/)) that provisions everything above in ~10 minutes from a single form — with security, observability, and cost controls **built-in by default**.

## Headline targets

| Metric | Manual baseline | With this platform |
|---|---|---|
| New service onboarding | ~2 days | ~10 minutes |
| Compliance coverage of new services | ~60% | 100% (by construction) |
| Platform-team throughput | 1× | 3–5× |
| Time to first production deploy | days | minutes |

> Numbers reflect **design targets**, not measured results. This project is an educational build; the metrics are grounded in industry benchmarks (e.g. Puppet's *State of Platform Engineering*) and will be re-measured after Phase 10.

---

## Architecture (high-level)

```text
Developer ──► Backstage Portal ──► GitHub ──► GitHub Actions ──► ECR
                     │                              │
                     ├──► Kubernetes API            └──► PR to GitOps repo
                     │        ▲                              │
                     └──► ArgoCD ◄── (reconciles) ───────────┘
                              │
                              ├──► Crossplane ──► AWS (RDS, S3, IAM, Secrets)
                              ├──► ExternalDNS ──► Route53
                              ├──► cert-manager ──► ACM / Let's Encrypt
                              ├──► External Secrets ──► AWS Secrets Manager
                              └──► App workloads on EKS
```

Full diagrams: **[docs/architecture/](docs/architecture/)** • Rationale for every choice: **[docs/adr/](docs/adr/)**.

### The two-plane mental model

- **Control plane** — Backstage, ArgoCD, Crossplane, GitHub Actions. Manages platform state.
- **Data plane** — Application pods, RDS instances, S3 buckets, DNS records. *Is* platform state.

The control plane never mutates the data plane directly; it writes to Git, and GitOps reconciles reality → Git.

---

## Tech stack

| Layer | Choice | Why (short) — full rationale in ADRs |
|---|---|---|
| Portal | **Backstage** | Industry-standard open developer portal; huge plugin ecosystem |
| IaC — baseline | **AWS CDK** (TypeScript) | Real code with types + tests, strong AWS integration |
| IaC — per-service | **Crossplane** | K8s-native infra API — devs get CRs, not CloudFormation permissions |
| Runtime | **Amazon EKS** | Managed control plane, IRSA for pod-level IAM, multi-AZ |
| GitOps CD | **ArgoCD** | Pull-based, mature UI, app-of-apps pattern |
| CI | **GitHub Actions** | Free tier, native to GitHub OAuth we already need |
| Secrets | **AWS Secrets Manager** + **External Secrets Operator** | Managed rotation, KMS-encrypted, K8s-native binding |
| Observability | **Prometheus / Grafana / Loki / Tempo / OpenTelemetry** | Open, self-hostable, industry-standard |
| Policy | **Kyverno** | Simpler YAML policies than OPA/Rego |
| Supply chain | **cosign** (Sigstore) + **syft** (SBOM) | Modern image signing + SBOM generation |

---

## Repository layout

```text
internal-developer-platform/
├── infra/          # AWS CDK — VPC, EKS cluster, ECR, Route53, KMS, IAM baseline (Phase 1+)
├── platform/       # In-cluster components — ArgoCD, Crossplane, observability, security (Phases 2–4, 8)
├── portal/         # Backstage app + custom plugins (Phase 5+)
├── templates/      # Golden path software templates (Phase 6+)
├── docs/
│   ├── architecture/   # C4 diagrams, sequence diagrams
│   ├── adr/            # Architecture Decision Records
│   ├── runbooks/       # Ops procedures
│   ├── phases/         # Phase-by-phase build log
│   └── COST.md         # Projected + actual AWS spend
├── .github/        # CI workflows, PR/issue templates, CODEOWNERS
├── CLAUDE.md       # AI collaborator instructions
├── Makefile        # `make bootstrap`, `make lint`, `make aws-up`, `make aws-down`
└── README.md       # (this file)
```

---

## Cost transparency

This project is **designed to be operable on ~$15–30 total AWS spend during development**, with a documented **~$200/month production footprint**. All development defaults to a **local `kind` cluster**; AWS resources are opt-in per session and torn down at the end of each session.

Detailed projected + actual spend per phase: **[docs/COST.md](docs/COST.md)**.

---

## Status & roadmap

Currently in **Phase 0 — Foundations & docs**. Progress log: **[docs/phases/](docs/phases/)**.

<details>
<summary>Full 10-phase roadmap</summary>

| Phase | Ships | Status |
|---|---|---|
| 0 | Repo scaffolding, ADRs, guardrails | 🔄 in progress |
| 1 | AWS baseline via CDK (VPC, EKS, ECR, Route53, KMS) | ⏳ |
| 2 | Cluster add-ons (ArgoCD, cert-manager, ESO, ExternalDNS, ingress) | ⏳ |
| 3 | Observability stack (Prometheus, Grafana, Loki, Tempo, OTel) | ⏳ |
| 4 | Crossplane + AWS provider + compositions | ⏳ |
| 5 | Backstage MVP (GitHub OAuth, K8s + ArgoCD plugins) | ⏳ |
| 6 | Golden path template — first end-to-end demo | ⏳ |
| 7 | CI/CD golden pipeline (SAST, image scan, sign, SBOM) | ⏳ |
| 8 | Security hardening (Kyverno, IRSA, NetworkPolicies) | ⏳ |
| 9 | Cost, DR, ops (Kubecost, backups, runbooks, chaos) | ⏳ |
| 10 | Polish for showcase (demo video, blog, LinkedIn, YouTube) | ⏳ |

</details>

---

## Quickstart

Coming in **Phase 1**. Until then, this repo is a documentation scaffold. You can already:

```bash
# Verify dev environment matches project pins
node --version   # should match .nvmrc (v22.x)
```

---

## Documentation

- **[Architecture](docs/architecture/)** — diagrams and design docs
- **[ADRs](docs/adr/)** — every non-obvious decision, with rationale
- **[Runbooks](docs/runbooks/)** — how to operate the platform
- **[Phase log](docs/phases/)** — what we built in each phase
- **[Cost](docs/COST.md)** — spend tracking
- **[AI collaborator guide](CLAUDE.md)** — for future Claude / AI sessions

---

## License

[MIT](LICENSE)
