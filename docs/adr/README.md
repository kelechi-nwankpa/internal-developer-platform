# Architecture Decision Records (ADRs)

This directory records every **non-obvious** architectural decision made on this project. Its purpose is institutional memory — six months from now, when someone asks *"why did we pick Crossplane over Terraform?"*, the answer is here, not in the head of whoever wrote the code.

## What is an ADR?

Introduced by [Michael Nygard in 2011](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions), an ADR is a short document (typically one page) that captures **a single architecturally significant decision**, its context, the options considered, and the consequences.

The value isn't in the finished document — it's in the *act of writing it*. Forcing yourself to articulate the trade-offs surfaces reasoning you'd otherwise skip.

## Format

We use the **[MADR](https://adr.github.io/madr/) format** (Markdown ADR). Every new ADR should copy [`template.md`](template.md) and fill in the sections.

## How to add a new ADR

1. Copy `template.md` to `NNNN-kebab-case-title.md` where `NNNN` is the next unused four-digit number.
2. Fill in every section. Empty sections signal weak decisions.
3. Set **Status** to `Proposed` if it's still under discussion, `Accepted` once the team (or you, for a solo project) is committed.
4. Add an entry to the index below.
5. Link from any code, runbook, or diagram that implements the decision.
6. **Never delete an ADR.** Superseded decisions are marked and linked forward. Historical rationale is more valuable than a tidy index.

## When to write one

- Any decision that would be hard for a new contributor to reverse-engineer from code.
- Any decision that goes against the obvious default.
- Any decision with meaningful trade-offs (cost, security, complexity).
- Any decision that ties us to a specific technology, vendor, or pattern.

If in doubt: write it. A cheap ADR is better than a lost rationale.

## Index

| # | Title | Status | Date |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted | 2026-07-03 |
| [0002](0002-use-aws-cdk-for-baseline-infra.md) | Use AWS CDK for baseline infrastructure | Accepted | 2026-07-03 |
| [0003](0003-use-crossplane-for-per-service-infra.md) | Use Crossplane for per-service infrastructure | Accepted | 2026-07-03 |
| [0004](0004-single-region-with-multi-region-readiness.md) | Single region deployment, multi-region-ready design | Accepted | 2026-07-03 |
| [0005](0005-local-first-development-with-kind.md) | Local-first development with kind | Accepted | 2026-07-03 |
| [0006](0006-gitignore-cdk-context-json.md) | Git-ignore `cdk.context.json` | Accepted | 2026-07-03 |
| [0007](0007-vpc-endpoints-instead-of-nat-gateway.md) | VPC Interface endpoints instead of a NAT Gateway | Accepted | 2026-07-08 |
| [0008](0008-customer-managed-kms-keys.md) | Customer-managed KMS keys, one per data domain | Accepted | 2026-07-09 |
| [0009](0009-github-oidc-federation.md) | GitHub Actions authenticates to AWS via OIDC, not long-lived keys | Accepted | 2026-07-09 |
| [0010](0010-fargate-only-eks-cluster.md) | Fargate-only EKS cluster (no managed node group) | Accepted | 2026-07-11 |
| [0011](0011-ecr-immutable-tags-per-domain-repos.md) | ECR with immutable tags and per-domain repositories | Accepted | 2026-07-11 |
| [0012](0012-subdomain-delegation-for-idp.md) | Subdomain delegation for `idp.seniormankelz.dev` | Accepted | 2026-07-11 |
| [0013](0013-cdk-nag-suppression-policy.md) | cdk-nag suppression policy | Accepted | 2026-07-12 |
| [0014](0014-argocd-raw-install-vs-helm.md) | Install ArgoCD from the raw pinned manifest, not the Helm chart | Accepted | 2026-07-20 |
| [0015](0015-argocd-app-of-apps-pattern.md) | Use the ArgoCD app-of-apps pattern for platform bootstrap | Accepted | 2026-07-21 |
| [0016](0016-cert-manager-install-via-helm.md) | Install cert-manager via the upstream Helm chart, as an ArgoCD Application | Accepted | 2026-07-27 |
| [0017](0017-cert-manager-issuer-strategy.md) | cert-manager ClusterIssuer strategy: SelfSigned on kind, Let's Encrypt on EKS | Accepted | 2026-07-28 |
| [0018](0018-external-secrets-install-via-helm.md) | Install External Secrets Operator (ESO) via the upstream Helm chart, as an ArgoCD Application | Accepted | 2026-07-28 |
| [0019](0019-vault-install-for-eso-kind-backend.md) | Install HashiCorp Vault (standalone + manual unseal) as the ESO backend on kind | Accepted | 2026-07-28 |
| [0020](0020-eso-backend-strategy.md) | ESO backend strategy: Vault on kind, AWS Secrets Manager on EKS | Accepted | 2026-07-28 |
| [0021](0021-external-dns-install-and-provider-strategy.md) | Install ExternalDNS via Helm; inmemory provider on kind, Route53 via IRSA on EKS | Accepted | 2026-08-03 |
| [0022](0022-aws-load-balancer-controller-defer-to-eks.md) | Defer AWS Load Balancer Controller install to Phase 9 EKS; document Phase 9 activation reference | Accepted | 2026-08-04 |
| [0023](0023-metrics-server-vs-prometheus.md) | Install metrics-server separately from the Prometheus stack; use `--kubelet-insecure-tls` on kind | Accepted | 2026-08-05 |
| [0024](0024-kube-prometheus-stack.md) | Install kube-prometheus-stack bundle (Prometheus + Grafana + Alertmanager + operator) as one ArgoCD Application | Accepted | 2026-08-05 |

## References

- [Nygard, *Documenting Architecture Decisions* (2011)](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [MADR format](https://adr.github.io/madr/)
- [ThoughtWorks Tech Radar — Lightweight ADRs](https://www.thoughtworks.com/radar/techniques/lightweight-architecture-decision-records)
