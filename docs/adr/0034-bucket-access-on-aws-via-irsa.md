# 0034 — Bucket access on AWS through IRSA, not a stored key

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

A service asks for a bucket with one `ObjectBucket` manifest
([ADR-0027](0027-first-xrd-objectbucket.md)). On kind the MinIO
Composition creates the bucket and a Secret with five keys:
`BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_ENDPOINT_URL`, `AWS_REGION`.

The S3 Composition, meant for EKS, created the bucket and its hardening
but nothing else: no IAM, no Secret. A service deployed on EKS would have
had a bucket it could not reach, and its pod would not even start (the
Secret is a required `envFrom`). It had never been rendered or tested.

The question: on AWS, how does the service's pod get permission to use
its bucket?

## Decision drivers

- No long-lived AWS credential stored in the cluster.
- Least privilege: one service, one bucket, nothing wider.
- The service's manifests and code stay the same on kind and EKS.
- Nothing heavy added to kind: the Docker VM is already short of memory.
- Testable at $0 before the paid EKS session.

## Options considered

### Option A — IAM User + AccessKey per bucket

Fills the same five keys as MinIO.

- ✅ Identical contract on both clusters; no template change.
- ❌ An access key that never expires, stored in a Kubernetes Secret and
  in Crossplane's connection Secret, rotated by hand. This is the
  credential type AWS tells you to stop using.

### Option B — IRSA (IAM Roles for Service Accounts)

Per bucket: an IAM policy for that bucket, an IAM role whose trust policy
names the cluster's OIDC provider and one ServiceAccount, and the
attachment. The Secret carries `AWS_ROLE_ARN` in place of the keys. The
pod presents its own short-lived ServiceAccount token to STS.

- ✅ No stored key; credentials last an hour and rotate themselves.
- ✅ Uses what exists: the IAM provider is installed, and the CDK cluster
  stack already creates and exports the OIDC provider.
- ✅ The service repo never mentions an AWS account or role: the role
  ARN arrives through the same Secret as the bucket name.
- ❌ The contract grows by one key, and each cluster fills a different
  subset. The template must mount a token for `sts.amazonaws.com`.
- ❌ The Composition needs one cluster fact (the OIDC provider ARN).

### Option C — EKS Pod Identity

AWS maps the ServiceAccount to the role; nothing in the Secret or pod.

- ✅ No OIDC trust policy to get wrong; the simplest pod.
- ❌ Needs `provider-aws-eks` (another provider pod on kind, where it
  could never be exercised) and the Pod Identity agent add-on. On
  Fargate, which the EKS session uses, Pod Identity is not supported.

## Decision

**Option B.** The S3 Composition creates Policy + Role +
RolePolicyAttachment and publishes `BUCKET_NAME`, `AWS_REGION`,
`AWS_ROLE_ARN`. Details that carry the security:

- **Trust:** `StringEquals` on both `<issuer>:sub`
  (`system:serviceaccount:<claim namespace>:<ServiceAccount>`) and
  `<issuer>:aud` (`sts.amazonaws.com`). Without `sub`, any pod in the
  cluster could assume the role. The ServiceAccount defaults to the
  claim's name (the golden-path convention) and can be set with
  `spec.parameters.serviceAccountName`.
- **Permissions:** list on the bucket, get/put/delete on its objects.
  No wildcard resource.
- **Cluster fact:** read from an EnvironmentConfig `idp-cluster`
  (`data.oidcProviderArn`). The issuer is derived from the ARN so the two
  cannot disagree. It is created during the EKS session and not
  committed, because it contains the account id.
- **Fail closed:** no EnvironmentConfig, a malformed ARN, or a bucket
  not created from a claim means the Composition errors and creates
  nothing.
- **Secret timing:** published all at once, only when the role exists
  and the policy is attached.
- **Names:** IAM names start with `idp-`, so the Crossplane provider's
  own IAM rights can be limited to `role/idp-*` and `policy/idp-*`.

Why the Secret and not the usual ServiceAccount annotation
(`eks.amazonaws.com/role-arn`): the annotation would put a role ARN in
every service repo, and it relies on the EKS webhook to inject the
variables. Through the Secret, the platform owns the value end to end and
the pod spec is the same on both clusters.

## Consequences

- ✅ No AWS key anywhere in the cluster for bucket access.
- ✅ `make composition-test` checks output, provider schemas and IAM
  rules offline; deliberate breakages fail it.
- ❌ The contract is now six keys with two subsets. A service must rely
  on the AWS SDK's default credential chain, not read the key variables
  itself.
- ❌ The Crossplane provider needs `iam:CreateRole` and friends. A role
  creator can escalate; the `idp-` prefix limits where, and a
  permissions boundary is the stronger control (see below).
- ❌ Not yet proven against AWS. The offline test cannot show that AWS
  accepts the resources or that a pod can read its bucket.

## When to revisit

- The platform becomes EKS-only on EC2 nodes: Option C is simpler.
- Before any shared or long-lived AWS account: add a permissions
  boundary to every role the provider creates.
- A service needs more than object read/write (for example multipart
  listing or object tagging): extend the policy per need, not with `s3:*`.

## Related decisions

- [ADR-0027](0027-first-xrd-objectbucket.md) — the ObjectBucket XRD and
  its two Compositions.
- [ADR-0005](0005-local-first-development-with-kind.md) — kind first; the MinIO
  Composition stays the default.

## References

- [IAM roles for service accounts](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)
- [AWS SDK credential provider chain: web identity](https://docs.aws.amazon.com/sdkref/latest/guide/feature-assume-role-credentials.html)
