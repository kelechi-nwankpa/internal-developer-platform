# 0022 — Defer AWS Load Balancer Controller install to Phase 9 EKS; document Phase 9 activation reference

- **Status:** Accepted
- **Date:** 2026-08-04
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 2 has installed 5 in-cluster platform components so far, each following the same "operator + config Application" pattern:

- cert-manager (ADR-0016) — SelfSigned issuer on kind is honest dev-mode
- External Secrets Operator (ADR-0018) + Vault (ADR-0019) — Vault provides a real backend for kind
- ExternalDNS (ADR-0021) — `inmemory` provider is a first-class supported dev mode

**AWS Load Balancer Controller (AWS LBC) breaks that pattern.** Its entire purpose is to call the AWS ELBv2 API on behalf of Kubernetes `Ingress` objects — provisioning ALBs, target groups, listeners, security groups, etc. Unlike ExternalDNS's `inmemory` or Vault's local storage backend, **AWS LBC has no honest dev-mode.** Every meaningful action requires actual AWS API access. There is no mock provider, no dry-run flag, no equivalent of `inmemory`.

The decision this ADR captures: given LBC's genuine EKS-only nature, do we install it on kind at all?

## Decision drivers

1. **Honesty in the platform narrative.** Every other Phase 2 component has a real dev-mode. Installing a semi-fake LBC on kind that does nothing useful would break the "if it's on the cluster it does real work" invariant.
2. **Portfolio narrative quality.** "We installed everything on kind, some things work, some crashloop" is worse than "we installed everything with an honest dev-mode; the one component that has no dev-mode we deferred to EKS with a full activation reference ready."
3. **Cluster impact.** A permanently-Degraded ArgoCD Application on kind is bad optics and bad practice.
4. **Phase 9 readiness.** Whatever we defer must have its activation path fully documented — not "we'll figure it out then."
5. **Pattern consistency where possible.** For the actual Phase 9 activation, the operator + config Application split should match cert-manager (ADR-0016) and ESO (ADR-0018) — Helm chart wrapped in ArgoCD Application, IRSA-annotated ServiceAccount for AWS access.

## Options considered

### Option A — Full skip on kind, ADR-only reference (chosen)

Write this ADR with the full Phase 9 activation manifest embedded (below). No `platform/argocd/apps/aws-lbc.yaml` file exists in the repo. Phase 9 EKS deploy creates the file from this ADR's template + fills placeholders.

- Pros: Honest — nothing fake on kind. Zero cluster impact. Cleanest portfolio narrative ("deferred what genuinely can't be proven locally"). Phase 9 activation is copy-YAML-from-ADR-and-fill-placeholders. Fastest Task 2.6 by design.
- Cons: The pattern of "one Application file per platform component" briefly breaks — Phase 2 ships 4 operator Applications instead of 5. Small cost; documented clearly here.

### Option B — Install with `replicas: 0`

Ship `platform/argocd/apps/aws-lbc.yaml` with `controller.replicaCount: 0` in Helm values. Application deploys, CRDs land, no controller pod actually runs. Phase 9 activation = bump replicas + add IRSA annotations.

- Pros: Pattern consistency. Chart renders and applies. ArgoCD Application status shows Synced/Healthy.
- Cons: Semi-fake. `Application` reports Healthy but the operator isn't actually doing anything. Confusing for anyone reading the cluster state ("why is the LBC deployment scaled to zero?"). Not much of a proving-the-wiring win — chart rendering is exercised, but that's it.

### Option C — Install with fake AWS region + no credentials

Ship the Application with a real Helm config but omit IRSA / static credentials. Controller starts up, tries to reach AWS APIs, fails with clear auth errors.

- Pros: Educational — shows the failure mode a Phase 9 engineer would see if IRSA misconfigured.
- Cons: Permanently-Degraded Application on kind. Bad portfolio material. Nothing to demonstrate other than "yes, it fails when it can't reach AWS."

### Option D — LocalStack as fake AWS backend

Deploy [LocalStack](https://localstack.cloud/) in kind, configure AWS LBC to point at LocalStack's ELBv2 endpoint via `--aws-region` + `--aws-endpoint`.

- Pros: Real controller talking to a fake-but-API-compatible AWS. Educational for anyone learning LocalStack.
- Cons: LocalStack's ELBv2 API surface is partial. AWS LBC's specific API dependency chain (targetgroup binding, WAF integration, subnet auto-discovery) isn't well-tested against LocalStack. High setup effort for niche portfolio value. Not the tool for this job.

## Decision

**Option A — skip on kind, ADR-only.**

Reason: honesty and portfolio narrative quality outweigh pattern consistency in this case. The four other operators we install on kind (cert-manager, ESO, Vault, ExternalDNS) all have honest dev-modes. LBC does not. Installing it anyway would break the invariant we've established for the whole phase.

Phase 9 activation guidance embedded below so nothing needs to be re-derived.

## Consequences

- **Positive:** Cluster state on kind stays clean (7 Applications, all Synced/Healthy, all actually functional). Portfolio narrative is honest — we defer what genuinely can't be proven locally. Phase 9 activation is a well-documented copy-from-ADR-and-fill exercise. Zero cluster overhead.
- **Negative:** The "one Application file per component" pattern gains a footnote in Phase 2. Anyone looking at `platform/argocd/apps/` will notice 4 operator Applications + config Applications, no aws-lbc.yaml. Documented in Phase 2 log and here.
- **Neutral:** Phase 9 activation requires more work than the other operators (IAM policy attach + IRSA setup + subnet tagging, in addition to just applying the Application). All well-documented here, and much of it duplicates the IRSA setup ExternalDNS and cert-manager DNS-01 will need — so the Phase 9 IRSA-plumbing work amortises across multiple operators.

## When to revisit

- **Phase 9 EKS activation.** Use the reference below to create `platform/argocd/apps/aws-lbc.yaml`, apply the IAM policy, annotate the SA with the IRSA role, tag the VPC subnets for ALB provisioning, deploy.
- **If AWS LBC adds a dev-mode / dry-run provider upstream.** Unlikely but possible; would trigger a "should we now install on kind too?" revisit.
- **If we adopt a non-AWS cloud alongside AWS.** GCP has its own equivalent (GKE Ingress). Azure has AGIC (Application Gateway Ingress Controller). Multi-cloud would change the LBC story entirely.

## Related decisions

- [ADR-0009](0009-github-oidc-federation.md) — the IRSA pattern AWS LBC will reuse for AWS API access.
- [ADR-0010](0010-fargate-only-eks-cluster.md) — Fargate-only EKS is what AWS LBC will provision ALBs for. Note: Fargate + ALB has some subnet-tagging nuances documented in the Phase 9 reference below.
- [ADR-0017](0017-cert-manager-issuer-strategy.md) — cert-manager DNS-01 also needs Route53 IAM on EKS. Both AWS LBC + cert-manager IRSA setups share Phase 9 dependencies.
- [ADR-0021](0021-external-dns-install-and-provider-strategy.md) — ExternalDNS + AWS LBC together complete the "declare an Ingress, get a public HTTPS URL" story. ExternalDNS reads `Ingress.status.loadBalancer.hostname` — which is populated by AWS LBC.

## Phase 9 activation reference

Everything below is the concrete Phase 9 work. This section IS the runbook for activation — no separate document needed.

### 1. Chart version pin (as of 2026-08-04)

Recommended pin for Phase 9 EKS deploy: **`v3.4.3`** (n-1, ~1 week of community soak). Latest `v3.5.0` is very fresh (released 2026-08-03); one week of "did anyone hit issues" is worth it for a production install. Reassess pin when the deploy actually happens — the calculus of "latest vs n-1" is time-sensitive.

**Repo URL:** `https://aws.github.io/eks-charts` (official AWS EKS Helm repo).
**Chart name:** `aws-load-balancer-controller`.
**Chart version tracks app version 1:1** — chart `v3.4.3` installs app `v3.4.3`.

### 2. IAM policy for the LBC role

AWS publishes the canonical policy at [`https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.13.4/docs/install/iam_policy.json`](https://github.com/kubernetes-sigs/aws-load-balancer-controller/blob/main/docs/install/iam_policy.json) (URL will need version bump matching the chart's app version at activation time).

At Phase 9 activation:

```bash
# 1. Download the current policy
curl -sfL https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v3.4.3/docs/install/iam_policy.json \
  -o iam_policy.json

# 2. Create the IAM policy in your AWS account
aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam_policy.json

# 3. Note the Policy ARN — you'll need it for the IRSA role trust setup
```

### 3. IRSA — the IAM role for the LBC SA

Same pattern established in [ADR-0009](0009-github-oidc-federation.md). The trust policy federates from the cluster's OIDC provider (from [ClusterStack](../../infra/lib/cluster-stack.ts)) to the specific ServiceAccount:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/<OIDC_PROVIDER_HOST>"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "<OIDC_PROVIDER_HOST>:sub": "system:serviceaccount:kube-system:aws-load-balancer-controller",
        "<OIDC_PROVIDER_HOST>:aud": "sts.amazonaws.com"
      }
    }
  }]
}
```

Attach the `AWSLoadBalancerControllerIAMPolicy` (from step 2) to this role.

### 4. VPC subnet tags (from Phase 1's VpcStack)

AWS LBC discovers subnets for ALB placement via tags. Public subnets used for ALBs must be tagged:

- `kubernetes.io/role/elb = 1` (for internet-facing ALBs)
- `kubernetes.io/role/internal-elb = 1` (for internal-only ALBs)
- `kubernetes.io/cluster/<cluster-name> = owned` or `shared`

This tagging should be added to Phase 1's `VpcStack` (or as a Phase 9 CDK addition) BEFORE deploying AWS LBC, otherwise the controller comes up but can't find subnets and Ingress provisioning fails.

### 5. The `platform/argocd/apps/aws-lbc.yaml` to create at Phase 9

```yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: aws-lbc
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default

  source:
    repoURL: https://aws.github.io/eks-charts
    chart: aws-load-balancer-controller
    # Pin at activation time — re-check the current stable vs the "wait one
    # release" advice from this ADR.
    targetRevision: v3.4.3
    helm:
      valuesObject:

        # ─────────────────────────────────────────────────────────────
        # Cluster identification — the LBC controller needs the cluster
        # name to filter Ingress objects and tag AWS resources.
        # ─────────────────────────────────────────────────────────────
        clusterName: idp-eks   # or whatever ClusterStack names it — verify

        # ─────────────────────────────────────────────────────────────
        # IRSA — the ServiceAccount annotation that grants AWS access
        # ─────────────────────────────────────────────────────────────
        serviceAccount:
          create: true
          name: aws-load-balancer-controller
          annotations:
            # Fill in the role ARN from IAM after creating the role in step 3.
            eks.amazonaws.com/role-arn: arn:aws:iam::<ACCOUNT_ID>:role/AWSLoadBalancerControllerRole

        # ─────────────────────────────────────────────────────────────
        # AWS region — required. Use the cluster's region (eu-west-1 per
        # ADR-0004 single-region posture).
        # ─────────────────────────────────────────────────────────────
        region: eu-west-1

        # ─────────────────────────────────────────────────────────────
        # VPC ID — optional but recommended. Speeds up controller startup
        # (skips API call to discover VPC). Get from Phase 1 VpcStack output.
        # ─────────────────────────────────────────────────────────────
        vpcId: vpc-xxxxxxxx  # fill from VpcStack output

        # ─────────────────────────────────────────────────────────────
        # Replicas — 2 for HA on prod EKS (Fargate can handle both replicas
        # provided they're in different AZs, which they will be with
        # anti-affinity — enabled by chart default).
        # ─────────────────────────────────────────────────────────────
        replicaCount: 2

        # ─────────────────────────────────────────────────────────────
        # Log level — info for production, debug for troubleshooting.
        # ─────────────────────────────────────────────────────────────
        logLevel: info

  destination:
    server: https://kubernetes.default.svc
    # Convention: LBC lives in kube-system (matches AWS's own install docs).
    namespace: kube-system

  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

### 6. Phase 9 activation checklist

- [ ] Deploy Phase 1's `ClusterStack` (EKS cluster running)
- [ ] Add subnet tagging to Phase 1's `VpcStack` (step 4)
- [ ] Redeploy `VpcStack` with new tags
- [ ] Download + apply IAM policy (step 2)
- [ ] Create IAM role with trust policy (step 3)
- [ ] Attach policy to role
- [ ] Copy the manifest above to `platform/argocd/apps/aws-lbc.yaml`
- [ ] Fill in placeholders: `<ACCOUNT_ID>`, `<OIDC_PROVIDER_HOST>`, `<cluster-name>`, `vpc-xxxxxxxx`, IRSA role ARN
- [ ] Update `targetRevision` if v3.4.3 is no longer the "n-1 with soak" choice
- [ ] Commit + push
- [ ] Verify: `kubectl get pods -n kube-system | grep aws-load-balancer-controller`
- [ ] Deploy a test Ingress with `ingressClassName: alb` — expect an ALB to appear in AWS console within ~90s
- [ ] Verify ExternalDNS (once activated) creates a Route53 record for that Ingress

## References

- [AWS LBC — installation docs](https://kubernetes-sigs.github.io/aws-load-balancer-controller/v3.4/deploy/installation/)
- [AWS LBC Helm chart values reference](https://artifacthub.io/packages/helm/aws/aws-load-balancer-controller)
- [AWS — IAM policy for LBC](https://github.com/kubernetes-sigs/aws-load-balancer-controller/blob/main/docs/install/iam_policy.json)
- [AWS — Subnet tagging for load balancers](https://docs.aws.amazon.com/eks/latest/userguide/network_reqs.html#network-requirements-subnets)
- [ADR-0009 — the IRSA pattern](0009-github-oidc-federation.md)
- [ADR-0010 — Fargate-only EKS + ALB subnet nuances](0010-fargate-only-eks-cluster.md)

## Interview framing

The one-liner: *"AWS Load Balancer Controller is genuinely EKS-only — unlike every other Phase 2 component, it has no honest dev-mode. cert-manager has SelfSigned, ESO has Vault-local, ExternalDNS has inmemory; LBC has nothing equivalent. Rather than install a permanently-Degraded Application on kind or fake it with LocalStack, I documented the full Phase 9 activation path in ADR-0022 — chart pin, IAM policy, IRSA setup, subnet tagging, complete manifest, activation checklist. Migration to real EKS is copy-YAML-from-ADR-and-fill-placeholders. Honesty about what can and can't be proven on kind is a portfolio narrative strength, not a weakness."*
