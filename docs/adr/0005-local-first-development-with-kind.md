# 0005 — Local-first development with kind

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

A full-time always-on version of this platform on AWS costs approximately **$200/month** (EKS control plane $73, NAT Gateway $32, worker nodes ~$60, ALB $16, RDS $12, misc $5–10). The project's hard budget cap is **$30 total AWS spend**. Portfolio value derives from the GitHub repository, the documentation, and a recorded demo — not from a running cluster that anyone can `kubectl` into.

We need a development workflow that:

- Lets every phase be built, tested, and iterated on for **$0**.
- Only touches AWS for CDK validation runs and the final recorded demo.
- Produces a platform that runs on both a local cluster and real EKS without divergent manifests.

## Decision drivers

- Hard $30 AWS budget cap.
- Fast iteration — local `kind` clusters spin up in ~30 seconds, EKS clusters in ~15 minutes.
- Portability — anything Kubernetes-native should behave identically on `kind` and EKS.
- Portfolio narrative — "cluster-agnostic platform" is a stronger interview story than "AWS-only".

## Options considered

### Option A — Always-on AWS

Provision the full stack on AWS on day one; leave it running.

- Pros: Realistic environment throughout development. No local/prod divergence.
- Cons: ~$200/month, blows the budget in one week.

### Option B — Local `kind` by default, AWS opt-in per session (chosen)

All in-cluster components (ArgoCD, Crossplane, cert-manager, observability, Backstage) developed against a local `kind` cluster. AWS is spun up on demand for CDK validation and the final demo, then torn down immediately.

- Pros: $0 baseline cost. Same K8s manifests deploy to both. `kind` starts in seconds. Forces the platform to be portable.
- Cons: Some AWS-integrations can only be validated with real credentials (IRSA, ExternalDNS/Route53, Crossplane's AWS provider). Requires end-to-end AWS tests before the final demo.

### Option C — LocalStack for everything

LocalStack emulates AWS APIs locally.

- Pros: Zero AWS spend.
- Cons: EKS is not usefully emulated. Emulation drift on services like IAM and STS causes phantom bugs. Distracts from the goal.

### Option D — k3d instead of kind

Similar to kind but Rancher-flavoured.

- Pros: Slightly lighter memory footprint.
- Cons: `kind` is the officially-endorsed test tool for upstream Kubernetes and has broader documentation. Marginal difference for our purposes.

## Decision

We chose **Option B — local `kind` by default, AWS opt-in per session**. All in-cluster development happens on `kind`. CDK code is developed via `cdk synth` + unit tests without deploying. AWS resources are deployed only when integration validation requires it, and torn down at end-of-session. Every phase must include a `make aws-down` target so teardown is one command.

## Consequences

- **Positive:** Costs stay within budget by construction. Same manifests deploy to `kind` and EKS — this itself becomes a portfolio talking point. Iteration is fast (~30s cluster startup). Reduces reliance on network and AWS availability during development.
- **Negative:** Some AWS-specific integrations (IRSA, ExternalDNS, AWS provider) can only be validated with real AWS credentials — an integration-test gap that must be closed with periodic AWS runs. Local memory pressure (Backstage + ArgoCD + Prometheus stack on one Docker daemon) requires Docker Desktop tuning.
- **Neutral:** Requires two "environments" mentally — the local `kind` cluster and the (occasional) EKS cluster. Config templating (helm values, kustomize overlays) must cleanly separate them.

## When to revisit

- If budget expands (e.g. sponsorship, employer sandbox account).
- If IRSA-related bugs slip past `kind` testing repeatedly — indicates the integration gap is too wide.
- If Docker Desktop resource limits become the bottleneck — move to `k3d` or split components across multiple clusters.

## Related decisions

- [ADR-0004](0004-single-region-with-multi-region-readiness.md) — the same budget discipline drives the multi-region choice.
- [ADR-0002](0002-use-aws-cdk-for-baseline-infra.md) — CDK's local `synth` capability makes this viable.
- [ADR-0006](0006-gitignore-cdk-context-json.md) — related to CDK's local-first behaviour.

## References

- [kind](https://kind.sigs.k8s.io/)
- [Docker Desktop resource limits](https://docs.docker.com/desktop/settings/mac/#resources)
