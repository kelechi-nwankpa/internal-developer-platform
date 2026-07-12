# 0009 — GitHub Actions authenticates to AWS via OIDC federation, not long-lived keys

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 7's CI/CD pipeline needs GitHub Actions to run `cdk deploy` against this AWS account. That requires GitHub Actions to authenticate to AWS somehow.

The historical default is to create an IAM user, generate an access key, and store `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` as GitHub Actions secrets. This has been the cause of countless incidents:

- Keys leaked to public repos (checked in accidentally).
- Keys copied to compromised laptops.
- Keys used from unauthorised runners.
- Keys never rotated, providing forever-access after developer offboarding.

Since 2021, GitHub Actions publishes an OIDC identity provider that AWS can federate with. This ADR captures why we use it and what trust conditions we require.

## Decision drivers

- Zero long-lived AWS secrets in GitHub.
- Rotation happens per workflow run (no ceremony).
- Auditability per workflow in CloudTrail.
- Portable to any OIDC-supporting CI (GitLab, CircleCI, etc.) if we migrate.
- Least-privilege at every layer of the assume-role chain.

## Options considered

### Option A — Long-lived IAM user + access key stored in GitHub Secrets

Traditional pattern.

- Pros: Simplest to set up. Universally supported.
- Cons: Long-lived credentials in a system (GitHub) outside AWS. No auto-rotation. Access continues after compromise until a human revokes. Poor auditability — CloudTrail shows the key doing things but not the workflow context. **This is the "how did this happen" pattern in every leaked-credentials incident.**

### Option B — GitHub OIDC federation with `sts:AssumeRoleWithWebIdentity` (chosen)

GitHub Actions mints a short-lived JWT per workflow run, signed by GitHub's OIDC provider. AWS validates it and returns AWS credentials with a ~1-hour lifetime, scoped to the assumed role.

- Pros: No long-lived credentials anywhere. Cryptographic trust, not shared-secret trust. Every assumption logged in CloudTrail with the workflow's `sub` claim intact. Trust conditions on `sub` scope the trust to the exact repo, branch, or environment.
- Cons: Setup slightly more complex (OIDC provider + trust policy). Requires care to configure `sub` conditions correctly — misconfigured trust is worse than no trust at all.

### Option C — AWS SSO / Identity Center for CI

Some orgs run CI through their SSO instance.

- Pros: Single source of truth for identity.
- Cons: Not designed for automation. Not idiomatic for GitHub Actions. Doesn't apply to solo/small teams.

### Option D — Static role assumption via a bastion account

Route CI through a dedicated CI account that assumes the target account's roles.

- Pros: Isolation. Useful in multi-account orgs.
- Cons: Overkill for single-account portfolio. Still needs a bootstrapping auth mechanism.

## Decision

**Option B — GitHub OIDC federation.**

Two trust conditions are non-negotiable:

1. **`aud` = `sts.amazonaws.com`.** AWS's documented audience. Without this, any GitHub OIDC token issued for any AWS-audience service could assume the role.
2. **`sub` matches `repo:kelechi-nwankpa/internal-developer-platform:*`** with specific patterns per role. Default: `ref:refs/heads/main` only. Without this, *any* GitHub user's workflow could assume the role — a critical trust bug.

**Layered least-privilege for the deploy role's permissions:** GitHub Actions never touches AWS APIs directly. Its role can *only* call `sts:AssumeRole` on the four CDK bootstrap roles (`cdk-hnb659fds-*`). CDK then assumes those roles to do the actual deploy. This means a compromise of the GitHub deploy role gives the attacker permission to invoke `cdk` deploys — but only the CDK-flow deploys, not arbitrary IAM/S3/EC2 actions. Two layers of scope.

## Consequences

- **Positive:** No long-lived AWS secrets in the repo or in GitHub Secrets. Every CloudTrail `AssumeRoleWithWebIdentity` event carries the workflow run's `sub` claim — you can trace "which workflow, on which branch, at which SHA" for every deploy. Portable to non-GitHub CI with minor config changes.
- **Negative:** Trust misconfiguration is more dangerous than long-lived keys — a role with `sub: repo:*` (missing repo scope) can be assumed by any GitHub user in the world. Tests explicitly assert both `aud` and `sub` conditions to prevent regression.
- **Neutral:** `sub` pattern grammar is GitHub-specific — future migration would require re-writing trust patterns for the new CI's `sub` format.

## When to revisit

- If we migrate to a non-GitHub CI (GitLab, Buildkite, CircleCI). All support OIDC; the trust patterns and issuer URL change but the shape is identical.
- If we adopt AWS Organizations / multi-account. Then a bastion account (Option D) becomes appropriate for isolation.
- If GitHub deprecates the OIDC provider (extremely unlikely — it's now the AWS-recommended pattern).

## Related decisions

- [ADR-0002](0002-use-aws-cdk-for-baseline-infra.md) — CDK bootstrap creates the roles that this deploy role is scoped to assume.
- Task 1.5 outputs the deploy-role ARN as `GitHubDeployRoleArn` via `CfnOutput`. Phase 7's workflow reads it there.

## References

- [GitHub Docs — About security hardening with OpenID Connect](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [AWS blog — Use IAM roles to connect GitHub Actions to actions in AWS](https://aws.amazon.com/blogs/security/use-iam-roles-to-connect-github-actions-to-actions-in-aws/)
- [aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials)
- [GitHub OIDC sub claim reference](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect#example-subject-claims)
