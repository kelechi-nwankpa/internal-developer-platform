# 0036 — A trimmed IAM policy for the AWS Load Balancer Controller

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

On EKS the Envoy proxy needs a network load balancer (NLB) in front of
it. Fargate has no nodes, so the NLB must send traffic straight to the
pod's IP address, and only the **AWS Load Balancer Controller** can set
that up. The controller calls AWS, so it needs an IAM role.

Its project publishes one policy for every use
([v3.6.3 `iam_policy.json`](https://github.com/kubernetes-sigs/aws-load-balancer-controller/blob/v3.6.3/docs/install/iam_policy.json)).
That policy allows these writes on `Resource: "*"` with no condition:

- open or close ports on any security group in the account;
- create a security group in any VPC;
- create, change or delete listeners and rules on any load balancer;
- attach or detach WAF and Shield protection.

CLAUDE.md forbids `Resource: "*"` on write actions without an ADR. The
AWS account is also shared with the owner's other projects, so those
rights would reach resources that have nothing to do with this one.

## Decision drivers

- A compromised controller pod must not be able to touch other projects.
- The NLB must come up first time: a retry in a billed session costs money.
- The policy must stay reviewable by one person.

## Options considered

### Option A — The published policy, unchanged

- Pros: What AWS and the project document. Least likely to miss a
  permission. Nothing to maintain on upgrade but a file copy.
- Cons: The wildcard writes above. Needs this ADR to excuse a rule
  instead of following it. Includes permissions for features we do not
  use (application load balancers, WAF, Shield, Cognito, certificates).

### Option B — A trimmed and tightened policy (chosen)

Keep only what an NLB with IP targets needs. Limit every write to this
region and account, and then to the project VPC or to resources tagged
for this cluster.

- Pros: The role cannot change another project's resources (one known
  gap, below). 54 actions against upstream's 80. Follows the project rule.
- Cons: If a needed action is missing, the NLB is not created. Has to be
  re-checked on every controller upgrade.

### Option C — AWS-managed policy

- Cons: There is none for this controller.

### Option D — No controller; the built-in ("in-tree") load balancer

- Cons: It registers nodes as targets. Fargate has none.

### Option E — EKS Auto Mode's built-in load balancing

- Pros: No controller to install and no role to write.
- Cons: Auto Mode runs EC2 nodes that AWS manages and adds a per-node
  fee. It is a different cluster design from ADR-0010 (Fargate-only).

## Decision

**Option B.** The role is `LoadBalancerControllerRole` in
[`infra/lib/load-balancer-controller-role.ts`](../../infra/lib/load-balancer-controller-role.ts).

### How each write is limited

| What | Limit |
|---|---|
| Describe/Get calls (29) | `Resource: "*"` (AWS allows nothing narrower), this region only |
| Create a security group | Only in the project VPC |
| Add/remove rules on a security group | Only groups in the project VPC |
| Delete or retag a security group | Only groups tagged `elbv2.k8s.aws/cluster = idp` |
| Create an NLB or target group | Only if the request tags it `elbv2.k8s.aws/cluster = idp` |
| Change or delete an NLB, target group or listener; register targets | Only if it carries that tag |
| Change tags | Never the cluster tag itself |
| Create the load balancing service-linked role | One exact ARN |

Why a tag is a safe limit: the controller tags everything it creates
with the cluster name. Checked in its source at v3.6.3
(`pkg/deploy/tracking/provider.go`, `pkg/deploy/elbv2/listener_manager.go`,
`pkg/networking/backend_sg_provider.go`). The policy stops the role from
adding that tag to something that already exists, so it cannot "adopt"
another project's load balancer and then change it.

Why security-group rules use the VPC, not the tag: the controller must
add a rule to the cluster's own security group (the one on the pods) to
let the NLB in. EKS creates that group; it does not carry the
controller's tag. The VPC belongs to this project alone.

Which resources and condition keys each action accepts was read from the
[AWS service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/),
not from memory.

### Left out

Application load balancer ARNs; listener rules; listener certificates;
WAF, WAFv2 and Shield; Cognito; ACM and IAM server certificates;
`ModifyCapacityReservation` (reserved capacity is billed) and
`ModifyIpPools`. TLS ends at Envoy, so the NLB only forwards TCP and
needs none of these. The install (task 3b) turns the matching
controller features off.

### Trust

IRSA: the role trusts the cluster's OIDC provider and accepts exactly
`system:serviceaccount:kube-system:aws-load-balancer-controller`, with
audience `sts.amazonaws.com`.

- EKS Pod Identity is newer and simpler, but it needs an agent on a
  node. Fargate has no nodes.
- `cluster.addServiceAccount()` would create the role and the
  ServiceAccount together, but then CDK writes into the cluster. Here
  only ArgoCD does that.

### cdk-nag

`AwsSolutions-IAM5` flags every `*` in a resource. Five remain in this
role: `Resource::*` on the read statement, and the four ARN patterns
that end in a resource id (`security-group/*`, `loadbalancer/net/*/*`,
`targetgroup/*/*`, `listener/net/*/*/*`). Ids do not exist until the
resource is created; the conditions above do the narrowing.

Each of the five has its own exception on this role, limited with
`appliesTo` to that exact string (ADR-0013). Approved by the owner on
2026-11-26.

Found while building this: `ClusterStack` carried a stack-wide IAM5
exception with no `appliesTo`, written in Phase 1 for CDK's own
custom-resource roles. It hid every wildcard in the stack, so it hid
these five too, and would have hidden a careless one added later. That
is the blanket ADR-0013 rejects. Approved the same day: it now matches
only CDK's own three patterns (`<lambda-arn>:*`, `eks:cluster/idp/*`,
`eks:fargateprofile/idp/*`), and the bare `*` on CDK's cluster
creation role has an exception on that one policy.

Proven by breaking it: an `app` load balancer ARN added to this role,
and a `Resource: "*"` added to another role in the stack, each fail
`cdk synth`. One limit: an exception matches a string, not a
statement, so a second `Resource: "*"` statement on this role would
pass cdk-nag. The unit tests catch that instead (exactly one `*`
statement, read-only).

## Consequences

- **Positive:** A stolen controller token is useful only inside this
  project's VPC and against this cluster's load balancers. The unit
  tests pin the whole policy, so any widening shows up in review.
- **Negative:** A missing permission shows up only in a live session,
  as `AccessDenied` in the controller's log with the action's name. The
  session runbook must say where to look and how to add one action.
- **Negative:** On a controller upgrade, compare the new published
  policy with the fixture in `infra/test/fixtures/` and decide for each
  new action.
- **Known gap:** tagging a listener while creating it. AWS documents the
  "only during creation" condition (`elasticloadbalancing:CreateAction`)
  for load balancers and target groups, not for listeners. So the role
  may tag any NLB listener in this region and account with
  `elbv2.k8s.aws/cluster = idp`, and could then change or delete that
  listener. Upstream allows any tag on any listener, so this is still
  narrower. Close it if `CreateAction = CreateListener` proves to work.
- **Known limit:** inside the project VPC the role can open ports on any
  security group, including the cluster's.
- **Not proven until the session:** that the trimmed list is enough.

## When to revisit

- **We use an application load balancer, WAF or NLB TLS listeners.**
  Add those actions back, with the same limits.
- **The trimmed list fails more than once in a session.** Fall back to
  Option A for the session and record why here.
- **Several clusters share an account.** The tag value already separates
  them; give each its own VPC.

## Related decisions

- [ADR-0010](0010-fargate-only-eks-cluster.md) — Fargate-only, the
  reason for IP targets and for IRSA over Pod Identity.
- [ADR-0013](0013-cdk-nag-suppression-policy.md) — how exceptions are scoped.
- [ADR-0033](0033-edge-routing-via-gateway-api.md) — the Gateway this
  load balancer fronts.
- [ADR-0034](0034-bucket-access-on-aws-via-irsa.md) — IRSA for buckets.
- [ADR-0035](0035-nat-gateway-for-eks-sessions.md) — the VPC.

## References

- [AWS Load Balancer Controller — installation](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/deploy/installation/)
- [Actions, resources and condition keys for ELB v2](https://docs.aws.amazon.com/service-authorization/latest/reference/list_awselasticloadbalancingv2.html)
- [Tagging ELB resources during creation](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/tagging-resources-during-creation.html)
- [IAM roles for service accounts](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)
