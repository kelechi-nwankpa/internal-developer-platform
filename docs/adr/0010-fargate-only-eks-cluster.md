# 0010 — Fargate-only EKS cluster (no managed node group)

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Amazon EKS gives us three compute options for pods:

1. **Managed node groups** — AWS-managed EC2 instances running the kubelet and the AWS VPC CNI. Standard pattern; well-understood.
2. **Self-managed nodes** — you own the EC2 fleet. Maximum control, maximum operational surface.
3. **AWS Fargate profiles** — serverless per-pod compute. No nodes, no OS patching, no capacity planning. Billed per pod-second.

For this platform's Phase 1 baseline we need to pick one (or a mix).

## Decision drivers

- Operational simplicity (this is a solo project — every extra runtime component is time not spent shipping features).
- Cost per session (short-lived demos, not always-on).
- Startup latency (Fargate pods take 30–60s to warm up; EC2 nodes are instant once warm).
- Compatibility with the platform components we plan to run (ArgoCD, Crossplane, Backstage, observability — none require privileged pods or DaemonSets fundamentally).
- Portfolio-story credibility.

## Options considered

### Option A — Managed node group, single AZ

One small managed node group (e.g., 2 × `t3.small` spot instances) in a single AZ.

- Pros: Cheapest per-hour ($0.02/hour for 2 spot t3.small). Instant pod scheduling. Supports privileged pods and DaemonSets. Standard, well-documented pattern.
- Cons: OS patching. AMI updates. Autoscaling policy. Capacity planning. Node draining. Every one of these is a piece of platform *operations* we don't need for a portfolio demo. Loses the "managed all the way" story.

### Option B — Managed node group, 3-AZ

Same as A but spanning 3 AZs for HA.

- Pros: Real HA at the node layer.
- Cons: All of A's cons, plus 3× the nodes to manage. Way more capacity than a demo needs.

### Option C — Fargate profiles only (chosen)

Every pod runs in a Fargate-managed micro-VM. No nodes at all.

- Pros: **Zero node ops.** Zero OS patching, zero autoscaling to configure, zero AMI drift. Pay-per-pod-second — empty cluster costs only the EKS control plane. Portfolio-clean "the platform runs itself" story. Matches AWS's own guidance for serverless EKS.
- Cons: **Startup latency ~30–60s per new pod** (Fargate has to schedule a task, pull the image, then boot). No DaemonSets — Fargate deliberately rejects them (kube-proxy and vpc-cni behaviour is handled internally). No privileged pods. Higher $/hour when a pod runs continuously vs a spot node.

### Option D — Hybrid: small node group + Fargate

Managed node group for kube-system and control-loop components (fast scheduling); Fargate for user workloads.

- Pros: Best of both — fast core scheduling, serverless user workloads.
- Cons: Two operational modes to reason about. Node group still needs OS patching. Adds Karpenter or Cluster Autoscaler in the picture. For a portfolio-scale demo, adds complexity without proportional benefit.

## Decision

**Option C — Fargate profiles only.**

The primary win is **zero node operations**. This project is a Platform Engineering portfolio piece; every operational task the platform *doesn't* require me to do is time freed for the platform features that make the portfolio distinctive (Backstage, Crossplane compositions, GitOps).

The primary trade-off — pod startup latency — is not a blocker for anything Phase 2+ needs. ArgoCD, cert-manager, ExternalDNS, ESO, Backstage all run as steady-state Deployments; the 30–60s cold start happens once per pod restart. Interactive workloads that need sub-second scheduling would flip this decision, but we don't have any.

We accept that a workload later in the project might legitimately need a node group (GPU, privileged, DaemonSet). If that happens, we **add** a managed node group without removing Fargate — Option D on demand rather than by default. That's an incremental change, not a rewrite.

## Consequences

- **Positive:** No OS patching. No AMI upgrades. No autoscaling policy. No node draining. Empty cluster = only EKS control-plane cost ($0.10/hour). Fargate profiles are declarative in CDK and versionable. Strong "the platform is managed all the way down" interview story.
- **Negative:** Pod startup ~30–60s. No DaemonSets — anything that wants to run on every node (e.g., traditional log shippers, node-exporter) needs a Fargate-friendly equivalent. Continuous-workload cost per pod exceeds a spot node group. If workloads later become CPU-heavy 24/7, Fargate becomes 2–3× more expensive than a right-sized node group.
- **Neutral:** Two Fargate profiles at Phase 1 (kube-system, default). Every additional namespace we add (argocd, cert-manager, external-secrets, external-dns) needs its own profile (or a shared multi-selector profile).

## When to revisit

- If a workload legitimately needs privileged pods, DaemonSets, or GPU — add a managed node group without removing Fargate.
- If continuous workload load rises to the point where Fargate is >2× more expensive than an equivalent node group.
- If Fargate's startup latency becomes user-facing (unlikely for platform components; possible for workload-facing user requests once we're serving real traffic).

## Related decisions

- [ADR-0004](0004-single-region-with-multi-region-readiness.md) — single-region posture bounds cluster scope.
- [ADR-0007](0007-vpc-endpoints-instead-of-nat-gateway.md) — the ECR and STS interface endpoints are what let Fargate pods pull images and authenticate without a NAT.
- [ADR-0008](0008-customer-managed-kms-keys.md) — `eksSecretsKey` from KmsStack is the envelope key for Kubernetes Secrets in this cluster.

## References

- [AWS docs — Amazon EKS on AWS Fargate](https://docs.aws.amazon.com/eks/latest/userguide/fargate.html)
- [Fargate profile selectors](https://docs.aws.amazon.com/eks/latest/userguide/fargate-profile.html)
- [AWS blog — Fargate pod startup optimization](https://aws.amazon.com/blogs/containers/reducing-aws-fargate-startup-times-with-zstd-compressed-container-images/)

## Postscript — the coredns deadlock (learned the hard way)

EKS ships the `coredns` Deployment with an annotation:

```yaml
metadata:
  annotations:
    eks.amazonaws.com/compute-type: ec2
```

That annotation tells the EKS scheduler: *"only schedule me on an EC2-managed node group; never on Fargate."* In a Fargate-only cluster there is no EC2 node group, so the pods refuse Fargate and sit `Pending` indefinitely. With no scheduled pods, no Fargate nodes are provisioned, and `kubectl get nodes` returns `No resources found`. Cluster is technically healthy but functionally dead.

CDK's `Cluster` construct exposes `coreDnsComputeType`:

- `CoreDnsComputeType.EC2` (default) — leaves the ec2 annotation in place.
- `CoreDnsComputeType.FARGATE` — CDK patches the Deployment to strip the annotation as part of provisioning.

**We set it to FARGATE.** Without this, every fresh deploy of ClusterStack requires a manual `kubectl patch` before the cluster is usable — an easy-to-forget footgun for the next platform engineer.

**Manual recovery (if the code is missing the setting on an already-deployed cluster):**

```bash
kubectl patch deployment coredns \
  --namespace kube-system \
  --type=json \
  --patch='[{"op": "remove", "path": "/spec/template/metadata/annotations/eks.amazonaws.com~1compute-type"}]'
kubectl rollout restart -n kube-system deployment coredns
```

**Interview framing:** *"EKS Fargate-only clusters have a subtle bootstrap dependency: coredns ships with an annotation that pins it to EC2, so pods deadlock on a Fargate-only cluster. CDK's coreDnsComputeType prop patches this at provisioning time. Missing it is one of the top 'why isn't my Fargate cluster working' issues."*
