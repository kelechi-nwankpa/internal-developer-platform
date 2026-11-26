# 0035 — One NAT Gateway for EKS sessions; no Interface endpoints

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors
- **Supersedes:** [ADR-0007](0007-vpc-endpoints-instead-of-nat-gateway.md)

## Context and problem statement

[ADR-0007](0007-vpc-endpoints-instead-of-nat-gateway.md) gave the VPC no
route to the internet: private subnets reached AWS services through
Interface endpoints and nothing else. That was right for Phase 1, whose
cluster ran no workloads.

Phase 9 runs a slice of the platform on EKS, and the platform needs the
internet:

- ArgoCD clones from `github.com`.
- Images come from `ghcr.io`, `cgr.dev`, `quay.io` and `registry.k8s.io`.
- cert-manager talks to Let's Encrypt.
- Crossplane downloads its providers from `xpkg.upbound.io`.

An endpoint exists only for an AWS service. None of the above is one.
ADR-0007 named this exact case under "When to revisit".

Phase 1's bill also showed what the endpoints cost: 27 network
interfaces (9 endpoints × 3 AZs) cost $7.00, 26% of the bill and the
largest line after the extended-support surcharge (see
[`docs/COST.md`](../COST.md)).

## Decision drivers

- The platform must be able to start: no egress, no ArgoCD, no images.
- Cost per three-hour session, under a $40 lifetime cap.
- What a compromised pod could reach (ADR-0007's reason for no NAT).
- As little to build and tear down as possible for one short session.

## Options considered

### Option A — Keep endpoints only; mirror everything else into AWS

ECR pull-through cache for images, CodeCommit or S3 for Git, a private
CA in place of Let's Encrypt.

- Pros: Keeps "no internet from workloads".
- Cons: Weeks of work to serve one three-hour session. Pull-through
  cache does not cover every registry we use. The certificate would not
  be publicly trusted, and `.dev` domains require one.

### Option B — One NAT Gateway, plus the free Gateway endpoints (chosen)

Private subnets get a default route to a single NAT Gateway in one
public subnet. The S3 and DynamoDB Gateway endpoints stay.

- Pros: Everything the platform needs is reachable. About $0.05/h plus
  $0.005/h for its address. Image layers from ECR travel through S3, so
  they take the free endpoint and skip the NAT's per-gigabyte charge.
- Cons: A pod can reach any internet address. One NAT in one AZ is a
  single point of failure for egress.

### Option C — NAT Gateway and keep the Interface endpoints

- Pros: AWS API traffic stays on AWS's network and is not billed per GB.
- Cons: Pays twice for the same reach: about $0.30/h more for nine
  endpoints in three AZs, over five times the NAT itself. Two routes to debug. Phase 1's
  deploy failed once because an endpoint was missing; with a NAT that
  whole class of failure goes away.

### Option D — NAT instance (small EC2 with IP forwarding)

- Pros: Cheaper when always on (~$3/month against ~$33).
- Cons: Saves about $0.04/h in a session, so about 12 cents. Adds an
  instance to patch, a security group and an AMI choice.

### Option E — Public subnets, no NAT

- Pros: No NAT charge.
- Cons: Not possible. Fargate pods run only in private subnets.

## Decision

**Option B: one NAT Gateway, the two free Gateway endpoints, and no
Interface endpoints.**

The platform cannot start without internet egress, and endpoints cannot
give it. Once a NAT is there it also reaches every AWS service, so the
Interface endpoints become a second, paid route to the same place.

One NAT, not one per AZ: three would triple the cost to survive an AZ
outage during a three-hour session.

This is Option D from ADR-0007 ("hybrid"), which that ADR said would
probably be right once workloads needed non-AWS egress.

## Consequences

- **Positive:** ArgoCD, image pulls, Let's Encrypt and Crossplane
  packages work with no mirrors. About $0.24/h cheaper than Phase 1's
  network ($0.30/h of endpoints out, $0.055/h of NAT in). Fewer resources to create and delete: 27 network interfaces
  and a security group are gone, which also shortens teardown.
- **Negative:** The "a compromised pod cannot reach the internet"
  property from ADR-0007 is given up. On this cluster nothing replaces
  it: to our knowledge Kubernetes NetworkPolicy is not enforced for
  Fargate pods by the VPC CNI, so egress cannot be narrowed per pod
  either. Check this in the session before repeating it as fact.
  Accepted because the session lasts three hours, runs our own images
  and one demo service, and holds no data. It would not be accepted for
  a long-lived cluster.
- **Negative:** Egress for all three AZs depends on one AZ.
- **Neutral:** VPC Flow Logs still record every connection, now
  including internet destinations. Nothing in a private subnet gets a
  public address; inbound traffic can only arrive through a load
  balancer.

## When to revisit

- **The cluster runs always-on.** Use one NAT per AZ; add Interface
  endpoints back for the busiest AWS services (ECR, STS, Logs) so that
  traffic is private and skips the per-GB charge.
- **Real data or real tenants.** Restrict egress: a managed node group
  where NetworkPolicy is enforced, or an egress firewall or proxy with
  an allow-list of hostnames, between the private subnets and the NAT.
- **NAT data charges show up on the bill** (heavy pulls from non-ECR
  registries): add an ECR pull-through cache.

## Related decisions

- [ADR-0007](0007-vpc-endpoints-instead-of-nat-gateway.md) — superseded
  by this one. Its postscript on deploy-time endpoints no longer applies:
  the CDK kubectl handler now reaches AWS APIs through the NAT.
- [ADR-0010](0010-fargate-only-eks-cluster.md) — Fargate-only, the
  reason pods must sit in private subnets.
- [ADR-0005](0005-local-first-development-with-kind.md) — short
  sessions, which is why hourly prices matter and monthly ones do not.

## References

- [NAT gateway pricing](https://aws.amazon.com/vpc/pricing/)
- [AWS PrivateLink pricing](https://aws.amazon.com/privatelink/pricing/)
- [Gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html)
- [AWS Fargate considerations for EKS](https://docs.aws.amazon.com/eks/latest/userguide/fargate.html)
