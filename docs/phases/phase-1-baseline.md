# Phase 1 — AWS baseline via CDK

- **Status:** ✅ Shipped
- **Started:** 2026-07-08 (CostStack deploy)
- **Finished:** 2026-07-13 (aws-down after study session)
- **Duration:** ~6 calendar days, ~4 focused build sessions + 1 half-day study session
- **Total AWS spend:** ~$14 (of $30 phase budget)

## Business problem

Every microservice a real engineering team ships needs the same foundational AWS layer before it can even boot: a VPC with subnets, an IAM role structure, encryption keys, a container registry, a DNS entry, a compute runtime. Today at most orgs, standing this up per service is a **2-day platform-team ticket queue**. It's the exact bottleneck this IDP project exists to abolish.

Phase 1 codifies that whole layer as reproducible Infrastructure-as-Code: **one `make aws-up` and 25 minutes later you have a running EKS cluster inside a security-hardened VPC with three CMKs, a GitHub-OIDC-federated deploy role, two ECR repos, and a public Route53 zone.** Zero clicks in the AWS console. Zero manual `kubectl apply`. Zero long-lived AWS access keys.

## Target users of this phase

- **Platform engineer (the author).** Needs an idempotent, defensible baseline they can `cdk destroy` between sessions and put back identically at any time.
- **Later-phase consumers.** Phase 2 (ArgoCD, cert-manager, ExternalDNS, ESO), Phase 4 (Crossplane), and Phase 5 (Backstage) all *live inside* the cluster and *consume* the IAM/KMS/DNS foundation this phase provides. If Phase 1 is wrong, every later phase is worse.
- **Security engineer.** Needs to audit IAM (no wildcards, no long-lived keys), KMS (customer-managed, rotated, per-domain), and network posture (deny-by-default egress via VPC endpoints).
- **Finance / ops.** Needs to attribute cloud spend by project and get paged before things get expensive.
- **Interviewers.** Need to look at the repo and, in 15 minutes, understand what shipped, why, and how it survived the first real deploy.

## Business value

- **Zero-touch reproducibility.** `make aws-up` on any laptop with valid AWS creds produces the same 7 stacks in the same dependency order. Same code produces the same platform, verified end-to-end during Task 1.12.
- **Cost visibility.** Four AWS Budgets (`$5/$15/$30/$50`) plus Cost Anomaly Detection wired from the very first `cdk deploy`. First alarm fired *exactly on time* during the study session — proving the guardrail works.
- **Security by default.** Envelope encryption of K8s secrets via CMK, IRSA-ready OIDC identity provider, no NAT Gateway, no wildcard IAM. Every deviation from the default is documented in an ADR.
- **Interview-ready portfolio.** 7 stacks + 61 tests + 7 phase-specific ADRs + a real recorded deploy → destroy cycle. Every design choice traceable.

## What shipped in this phase

| Sub-task | What | Status |
|---|---|---|
| 1.1 | CDK app scaffolding (`infra/` package, tsconfig, jest, cdk-nag wired) | ✅ |
| 1.2 | CostStack — 4× Budgets + Anomaly Detection + tag Aspect | ✅ deployed |
| 1.3 | VpcStack — 3-AZ VPC, VPC endpoints, no NAT | ✅ deployed |
| 1.4 | KmsStack — 3 CMKs per data domain, annual rotation | ✅ deployed |
| 1.5 | IamStack — GitHub OIDC federation + least-privilege deploy role | ✅ deployed |
| 1.6 | ClusterStack — Fargate-only EKS 1.31 with IRSA + envelope encryption | ✅ deployed |
| 1.7 | RegistryStack — 2 ECR repos, immutable tags, KMS-encrypted | ✅ deployed |
| 1.8 | DnsStack — Route53 hosted zone for `idp.seniormankelz.dev` | ✅ deployed |
| 1.9 | Namecheap NS delegation runbook | ✅ written + executed |
| 1.10 | cdk-nag suppression review — 18 findings triaged, ADR-0013 written | ✅ |
| 1.11 | Makefile with real `aws-up` / `aws-down` / `cost` / `aws-diff` / `aws-status` / `aws-nuke` targets | ✅ |
| 1.12 | End-to-end deploy → study → destroy session | ✅ Total spend $14 |

**7 CDK stacks. 61 unit + snapshot tests. All green.**

## Key decisions (ADRs written this phase)

| # | Decision | Why interesting for portfolio |
|---|---|---|
| [ADR-0007](../adr/0007-vpc-endpoints-instead-of-nat-gateway.md) | VPC Interface endpoints instead of a NAT Gateway | The postscript documents the deploy-time endpoint gap I hit and root-caused live |
| [ADR-0008](../adr/0008-customer-managed-kms-keys.md) | Customer-managed KMS keys, one per data domain | Blast-radius containment framing; interviewers listen for this |
| [ADR-0009](../adr/0009-github-oidc-federation.md) | GitHub Actions authenticates to AWS via OIDC, not long-lived keys | Real security-hardening story |
| [ADR-0010](../adr/0010-fargate-only-eks-cluster.md) | Fargate-only EKS cluster (no managed node group) | Postscript documents the coredns compute-type deadlock live-recovered |
| [ADR-0011](../adr/0011-ecr-immutable-tags-per-domain-repos.md) | ECR with immutable tags and per-domain repositories | Ties to CLAUDE.md §9 no-`latest` non-negotiable |
| [ADR-0012](../adr/0012-subdomain-delegation-for-idp.md) | Subdomain delegation for `idp.seniormankelz.dev` | Zero-downtime, apex-preserving migration story; verified live |
| [ADR-0013](../adr/0013-cdk-nag-suppression-policy.md) | cdk-nag suppression policy | Documents *why* every suppression exists — auditability without tooling |

## What was learned

### The three real bugs the platform threw at me during Task 1.12

**1. VPC endpoint gap for CDK's KubectlHandler Lambda.** Deployed with 5 Interface endpoints (ECR api, ECR dkr, Logs, STS, KMS) — those handle Fargate *pods* running. Then `Cluster/AwsAuth/manifest/Resource/Default` timed out at `waitUntilFunctionActiveV2 (@aws-sdk/client-lambda)`. Root cause: CDK aws-eks places the KubectlHandler Lambda in the same isolated subnets as the workloads; that Lambda calls Lambda control-plane APIs to check whether target functions are `Active`. From an isolated subnet with no NAT and no Lambda endpoint, the call reaches nothing. Fix: added EC2, EKS, Lambda, ELB endpoints. **9 endpoints total.** Documented in ADR-0007 postscript.

**2. coredns Fargate deadlock.** After ClusterStack finally deployed cleanly, `kubectl get pods -A` showed both coredns pods `Pending` for 28 minutes. Root cause: EKS ships coredns with an annotation `eks.amazonaws.com/compute-type: ec2` that pins it to managed EC2 nodes. In a Fargate-only cluster, the Fargate profile matches by namespace but the pod refuses Fargate — deadlock. Fix: manual `kubectl patch` to recover; then permanent fix by setting `coreDnsComputeType: CoreDnsComputeType.FARGATE` in the CDK. Documented in ADR-0010 postscript.

**3. Tag-based cost attribution gap.** `make cost` filtered by `Project=idp` showed $3.82. Total account spend was $13.99. 73% of the platform's real spend never touched the tag — EKS control plane, VPC endpoint hours, and CloudWatch log ingestion are all billed at the account/service level and don't propagate resource tags to billing. Reinforced the "two overlapping budgets" pattern (tag-scoped + account-total).

### CDK / tooling nuances worth banking

- **`Parameters<typeof Class>` doesn't work on classes.** For CDK construct constructor arg extraction, `ConstructorParameters<typeof Class>[N]` is the correct utility. My cluster-stack test hit this exact bug.
- **`cdk-nag` `addResourceSuppressions(construct, ..., applyToChildren)` doesn't cross nested-stack boundaries.** CDK aws-eks puts its Provider Framework in a nested stack. Use `addStackSuppressions(this, ..., applyToNestedStacks: true)` when the flagged resource is behind a nested stack.
- **`cdk-nag` fires validation errors (not rule violations) when checking a CloudFormation token.** If a security group's CIDR is `Fn::GetAtt` at synth time, `AwsSolutions-EC23` can't inspect it and errors. Use the source literal (not `vpc.vpcCidrBlock`) so the rule can validate.
- **CDK L2 constructs frequently hide behind `Custom::AWSCDK-*` custom resources instead of native CFN types.** Tests using `template.findResources('AWS::EKS::Cluster')` return zero matches when the L2 uses a Lambda-backed custom resource. Read the actual synthesised template (grep the snapshot for `"Type":`) to find the real resource types.
- **CDK deliberately broke the CLI-vs-library version lockstep in 2.179+.** CLI is on 2.11xx track; library on 2.2xx. Pin them independently; don't expect `aws-cdk` and `aws-cdk-lib` at the same number.
- **`git add path/from/repo-root` from inside a subdirectory silently no-ops.** Pre-commit runs cleanly with nothing staged, and `git push` says "Everything up-to-date" — the smoke signal that no commits actually happened.

### About the cost reality

The original ADR-0007 estimate was `$0.60/session for 5 endpoints`. Reality with 9 endpoints × 3 AZs across ~20 hours of continuous run: **$5.40 of endpoints + $2 of EKS + $3 of CloudWatch logs + $2.60 of everything else = ~$14 total.** The "no NAT" story is architecturally right but financially neutral to a NAT Gateway — the choice is about workload isolation posture, not about saving money.

## What was deferred (intentionally)

- **Multi-region.** ADR-0004 stands — single-region deployed, multi-region-ready design.
- **Private-only cluster endpoint.** Currently PUBLIC_AND_PRIVATE for kubectl-from-laptop convenience. Phase 8 hardening.
- **Enhanced ECR scanning (Inspector-based).** Currently basic scan-on-push (free). Phase 8.
- **Kyverno + cosign image signing.** Phase 8 security hardening.
- **ExternalDNS + cert-manager IAM policies.** Phase 2 (they consume the IamStack + DnsStack this phase created).
- **Fargate spot / Karpenter.** Phase 8+ workload optimisation.
- **CDK feature-flag adoption** (`@aws-cdk/core:defaultCrossStackReferences` and 75 others). Will address in a batch when we bump CDK versions.

## Interview talking points

Ready-to-deliver, 30-90 seconds each.

1. **"6 ADRs before the first line of code; 7 more during Phase 1. Every non-obvious decision has a written rationale — reviewers can audit the security posture by reading the ADR index, not by tracing IAM policies."**
2. **"My first deploy failed on a subtle VPC endpoint gap. I root-caused it by reading the SDK method name in the timeout stack trace — `waitUntilFunctionActive` maps to Lambda's control-plane API, so I knew immediately that a Lambda VPC endpoint was missing. The fix was 4 endpoints. Documented in the ADR postscript."**
3. **"EKS ships coredns with an `eks.amazonaws.com/compute-type: ec2` annotation that deadlocks Fargate-only clusters. I recognised the failure pattern from AWS docs, patched it live with kubectl, then updated the CDK code to prevent it on the next fresh deploy."**
4. **"Tag-based cost attribution in AWS is a leaky abstraction — on my platform it caught 27% of spend. The EKS control plane, VPC endpoint hours, and CloudWatch log ingestion never got attributed. That's why I run overlapping budgets: tag-scoped for project-level attribution and account-total as the safety net."**
5. **"CDK L2 for EKS uses nested stacks for the Provider Framework. `addResourceSuppressions` doesn't cross nested-stack boundaries, so my first cdk-nag suppression pass silently missed half the findings. Switching to `addStackSuppressions` with `applyToNestedStacks: true` fixed it. This is the kind of nuance you only learn by running the tool against real code."**
6. **"Every K8s Secret in my cluster went through customer-managed KMS envelope encryption. I proved it live in CloudTrail during the study session — created a test secret, waited 60 seconds, saw the Decrypt event on `idp/eks-secrets`. That's the difference between claiming envelope encryption in a doc and demonstrating it end-to-end."**
7. **"9 VPC Interface endpoints × 3 AZs = $6.50/day. That's the actual cost of the 'no-internet-from-workloads' security posture. I originally framed 'no NAT' as a cost play; the real reality is that it's an architectural choice with roughly neutral cost. I updated ADR-0007 with the honest math."**

## Recruiter / hiring-manager Q&A prep

- **"What was the biggest technical challenge?"** — *"The VPC endpoint gap. My first ClusterStack deploy hung for 6 minutes then failed on the aws-auth ConfigMap. The stack trace referenced `waitUntilFunctionActive` — a Lambda control-plane API — and I knew from that alone that my endpoints didn't cover Lambda-to-Lambda calls from inside the VPC. I added EC2, EKS, Lambda, and ELB endpoints, tore down the failed stack, redeployed cleanly."*
- **"What did it cost?"** — *"$14 across a 20-hour continuous run. About $6.50/day of VPC endpoints, $2.40/day of EKS control plane, $3/day of CloudWatch log ingestion. My four AWS Budgets alerted exactly at $8.50 the next morning — the guardrail worked."*
- **"If you did it again, what would you change?"** — *"Add all 9 required VPC endpoints and the `coreDnsComputeType: FARGATE` prop up front. Both are one-line CDK settings that would have made the first deploy clean. That's now baked into the code so the next deploy won't hit them."*
- **"Why Fargate over managed node groups?"** — *"Zero node ops for a portfolio project — no OS patching, no autoscaling policy, no AMI updates. Trade-off is 30-60 second pod startup latency vs instant scheduling on a warm node. Fine for platform components; I'd add a spot node group if a workload legitimately needed sub-second scheduling."*
- **"Was this multi-region?"** — *"Single-region deployed, multi-region-ready in design. Every stack is region-parameterised; adding a second region is CDK's dependency graph plus new NS records at Route53. ADR-0004 documents the exact rollout runbook."*
- **"How do you know your security posture actually works?"** — *"Three ways. First: cdk-nag runs on every synth; 18 findings all suppressed with defensible reasons. Second: KMS Decrypt events in CloudTrail confirm envelope encryption is happening. Third: the K8s audit log captures every API call with the caller identity and RBAC decision — verified live."*

## Content extraction ideas

### LinkedIn posts

- *"I deployed a full IDP baseline on AWS and left it up overnight. Here's what $14 taught me about cost attribution, VPC endpoints, and why 'no NAT' is really an architecture choice, not a cost play."*
- *"7 CDK stacks, 61 tests, 13 ADRs, one live coredns deadlock and one hung Lambda waiter. What Phase 1 of my Internal Developer Platform looks like in the trenches."*

### LinkedIn carousel

- *"12 things I only understood after touching a live EKS cluster"* — one card per learning above.

### Blog post

- *"Deploying a Fargate-only EKS cluster with CDK: the three gotchas the docs don't tell you"* — VPC endpoints for the KubectlHandler, coredns compute-type annotation, tag-based cost attribution gap. Real code, real stack traces, real dollars.

### YouTube video

- *"Debugging an EKS deploy that hangs on aws-auth — root causing from the SDK method name to a missing VPC endpoint"* — 15 min screen-share, includes the terminal output and the ADR-0007 postscript walkthrough.

### Interview STAR examples

- **Situation:** First deploy of a Fargate-only EKS cluster into a private VPC failed.
- **Task:** Identify why `Cluster/AwsAuth/manifest/Resource/Default` timed out and stopped the whole stack from creating.
- **Action:** Read the SDK method in the stack trace (`waitUntilFunctionActiveV2`), traced back to Lambda control-plane API, mapped that back to the CDK KubectlHandler Lambda placement in isolated subnets. Added 4 missing VPC endpoints (EC2, EKS, Lambda, ELB), documented the postscript in ADR-0007.
- **Result:** Redeployed cleanly, cluster came up in 18 minutes. Total additional cost: <$1. Same failure won't recur on future fresh deploys.

## Suggested commit

```text
docs(phase): add phase-1-baseline log

Wraps up Phase 1 with an honest post-mortem: 7 stacks shipped, $14 total
spend across a 20-hour continuous run, three real bugs debugged live
(missing VPC endpoints for KubectlHandler, coredns Fargate deadlock,
tag-attribution gap between $3.82 tagged and $13.99 total account).

Includes interview talking points, recruiter Q&A prep, and content
extraction ideas for LinkedIn/blog/YouTube.
```

## Suggested LinkedIn post to publish now

> Just finished Phase 1 of my Internal Developer Platform side project.
>
> 7 CDK stacks. 61 tests. 13 ADRs. One 20-hour continuous run on AWS. $14 total spend. Three genuine bugs found and root-caused live.
>
> The most interesting lesson: I originally framed "no NAT Gateway" as a cost play. Turns out that 9 VPC Interface endpoints × 3 AZs = $6.50/day. It's not a cost win over NAT — it's an architectural choice that keeps a compromised pod contained to AWS-service traffic only. Updated the ADR with the honest math.
>
> Tag-based cost attribution caught 27% of my spend. The EKS control plane and CloudWatch log ingestion don't propagate tags to billing. That's why I run overlapping budgets — tag-scoped for project-level attribution and account-total as the safety net. The account-total budget fired at exactly the right moment the next morning.
>
> Next up: Phase 2 — ArgoCD, cert-manager, ExternalDNS, ESO. All on a local kind cluster, zero AWS spend.
>
> Repo: github.com/kelechi-nwankpa/internal-developer-platform

## Content status

- [x] Live deploy proven
- [x] All ADRs updated with postscripts of real lessons
- [x] Phase 1 log written (this doc)
- [ ] LinkedIn post published
- [ ] Blog post drafted
- [ ] YouTube video recorded
