# platform/ — in-cluster components (the platform runtime)

**Contents:** Kubernetes manifests, Helm chart values, and Crossplane compositions for every component that runs **inside** the cluster and turns raw Kubernetes into a *platform*.

## What lives here

Roughly the order in which each component arrives:

| Component | Introduced in | Purpose |
|---|---|---|
| **ArgoCD** | Phase 2 | GitOps continuous delivery. The app-of-apps root points here. |
| **cert-manager** | Phase 2 | Automated TLS certificate issuance (Let's Encrypt / ACM). |
| **ExternalDNS** | Phase 2 | Auto-populates Route53 records from Ingress annotations. |
| **AWS Load Balancer Controller** | Phase 2 | ALB provisioning driven by Ingress objects. |
| **External Secrets Operator (ESO)** | Phase 2 | Materialises Kubernetes `Secret` objects from AWS Secrets Manager. |
| **metrics-server** | Phase 3 | Basic CPU/memory metrics for HPA. |
| **Prometheus + Grafana + Loki + Tempo** | Phase 3 | Observability stack (metrics, logs, traces). |
| **OpenTelemetry Collector** | Phase 3 | Unified telemetry pipeline. |
| **Crossplane + provider-aws** | Phase 4 | K8s-native infra API — provisions per-service AWS resources on demand. |
| **Crossplane Compositions (XRDs)** | Phase 4 | Opinionated abstractions: `PostgresDatabase`, `ObjectBucket`, `ManagedSecret`, `Namespace`. |
| **Kyverno** | Phase 8 | Policy engine — blocks `:latest` tags, wildcard IAM, unsigned images, etc. |
| **NetworkPolicies** | Phase 8 | Deny-by-default east-west traffic. |
| **image verification (cosign)** | Phase 8 | Kyverno rule that admission-blocks unsigned images. |

## Why this is its own directory

Everything here is **GitOps-managed** (see [CLAUDE.md §4](../CLAUDE.md)). ArgoCD reconciles the state of the cluster to whatever lives here. Manual `kubectl apply` against a real cluster is a debugging tool, not a workflow.

This separates from `infra/` because these components run *inside* the cluster the substrate provides — they don't provision the substrate itself. And it separates from `portal/` because Backstage is a developer-facing UI, not a cluster runtime component.

## When this arrives

**Phase 2** and expands through Phases 3, 4, and 8.

## Local workflow

Everything here targets a local `kind` cluster by default (see [ADR-0005](../docs/adr/0005-local-first-development-with-kind.md)):

```bash
make kind-up               # starts local kind cluster (Phase 2+)
kubectl apply -k platform/argocd     # bootstrap ArgoCD once, then GitOps takes over
# ArgoCD reconciles the rest of platform/ from Git
```

## Relates to

- `infra/` — provides the AWS substrate this runtime runs inside.
- `portal/` — the developer-facing UI that *drives* provisioning through Crossplane compositions defined here.
- `templates/` — golden paths that scaffold workloads which then get deployed via ArgoCD (managed here).
