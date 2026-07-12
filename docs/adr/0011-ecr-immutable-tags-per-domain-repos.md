# 0011 — ECR with immutable tags and per-domain repositories

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

The platform will build, scan, and deploy container images. We need a registry story that:

- **Prevents production drift.** A tag like `foo:v1` should refer to the same image bytes forever.
- **Enforces domain isolation.** Platform-team images (Backstage, controllers) and application images (built by golden-path-scaffolded services) should be reasonable to separate for IAM scoping, lifecycle policies, and cost attribution.
- **Encrypts image layers at rest with a CMK** so ECR access is auditable in CloudTrail.
- **Scans images at push time** so vulnerabilities surface at the earliest point, not at deploy.
- **Bounds storage cost.** ECR is $0.10/GB-month. Untagged image accumulation is a real problem.

## Decision drivers

- CLAUDE.md §9 non-negotiable: no `:latest` tags in Kubernetes manifests. Registry policy must reinforce this.
- Cost: storage cost grows silently.
- Auditability: knowing who pulled/decrypted image layers matters for a security review.
- Blast radius: platform vs application separation.

## Options considered

### Option A — One shared repository, mutable tags

Everything under `idp/all`, tag mutability MUTABLE.

- Pros: One repo to manage. Cheapest to set up.
- Cons: `latest` can be re-pushed silently — makes deploys non-reproducible. No domain separation. IAM must be tag-based (fragile).

### Option B — One repository per service, mutable tags

Each service scaffolded via golden path gets its own repo. Tags mutable.

- Pros: Fine domain isolation. Per-service lifecycle policies.
- Cons: Repo sprawl (100 services → 100 repos, 100 lifecycle policies to maintain). Still has the `latest` re-push problem.

### Option C — Per-domain repositories, immutable tags (chosen)

Two seed repositories at Phase 1: `idp/platform` (platform team) and `idp/apps` (application layer, populated by golden-path templates). Tag mutability IMMUTABLE. Encryption KMS. Scan on push. Lifecycle: keep last 10 untagged, delete anything older than 90 days.

- Pros: Bounded number of repos (2 today; per-service sub-paths under `idp/apps/<service>` in Phase 6). Immutable tags force content-addressed or semver naming — no `latest` re-push. KMS encryption with the domain CMK from ADR-0008.
- Cons: Immutable tags means retries must use a new tag (git SHA suffix works). Slight dev-loop friction.

### Option D — Per-domain repositories, mutable tags

Same as C but MUTABLE.

- Pros: Easier dev iteration.
- Cons: Loses the "no `latest` re-push" guarantee — reintroduces the CLAUDE.md §9 violation we explicitly prohibited.

## Decision

**Option C — per-domain repositories with IMMUTABLE tags.**

Phase 1 creates two seed repos:

- `idp/platform` — platform-team-owned images.
- `idp/apps` — application images from golden-path services.

In Phase 6, the golden-path template can create sub-path repos like `idp/apps/user-service` for per-service isolation without extending this baseline. Immutable tags mean every deploy uses a fresh git-SHA-suffixed tag; no re-pushing.

Lifecycle policy: retain 10 untagged (buffer for in-flight pushes) + delete anything older than 90 days (bounded storage growth).

## Consequences

- **Positive:** No `latest` re-push footgun. Every image tag is a permanent record. KMS-encrypted, CloudTrail-audited layer decryption. Bounded storage. Domain separation for future IAM scoping.
- **Negative:** Push retries require a new tag (append git SHA or timestamp). Dev iteration slightly slower for anyone used to re-pushing `latest`.
- **Neutral:** Two repos to start; expected to grow to per-service sub-paths under `idp/apps` in Phase 6.

## When to revisit

- If image storage cost outgrows expected (>$10/month), tighten the lifecycle policy (reduce untagged retention, reduce max age).
- If dev iteration friction from immutable tags becomes a real pain, consider making a separate `idp/dev` repo with MUTABLE tags for pre-merge experimentation.
- If we adopt cross-region replication (Phase 10 stretch), verify the KMS key strategy still works.

## Related decisions

- [ADR-0008](0008-customer-managed-kms-keys.md) — `ecrKey` from KmsStack encrypts image layers here.
- CLAUDE.md §9 non-negotiable #4 — this ADR is the registry-layer half of that guarantee; Kyverno policy in Phase 8 enforces the Kubernetes-manifest half.

## References

- [Amazon ECR immutable image tags](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-tag-mutability.html)
- [ECR pricing](https://aws.amazon.com/ecr/pricing/)
- [ECR lifecycle policies](https://docs.aws.amazon.com/AmazonECR/latest/userguide/LifecyclePolicies.html)
