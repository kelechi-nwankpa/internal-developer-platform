# 0006 — Git-ignore `cdk.context.json`

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

When CDK code calls context providers like `Vpc.fromLookup()`, `HostedZone.fromLookup()`, or `MachineImage.latestAmazonLinux2()`, the CDK CLI queries AWS during `cdk synth` and **caches the result in `cdk.context.json`** at the project root. Subsequent synths reuse the cached value, producing deterministic templates.

The **AWS-recommended default** is to **commit** `cdk.context.json` to version control, so that CI produces the same CloudFormation as a developer's laptop. This is the right choice in most production environments.

For this project, we're going against the default. This ADR captures the reasoning so future contributors (or future-us) don't reverse it without understanding why.

## Decision drivers

- Public GitHub repo — leaked context can expose account-specific identifiers.
- Very few deploys — reproducibility across environments is a small win here.
- Learning workflow — switching between accounts and regions during development is expected.
- Simplicity of the demo — we want each `cdk synth` to reflect current AWS state, not a snapshot.

## Options considered

### Option A — Commit `cdk.context.json` (AWS-recommended default)

Standard CDK behaviour.

- Pros: Reproducible synth across environments. No AWS credentials required to synth. Snapshot tests are stable.
- Cons: Committed file may contain VPC IDs, hosted zone IDs, AZ mappings — account-scoped identifiers that pollute a public portfolio repo. Silent staleness risk if AWS state changes and no one notices. Encourages "commit + forget" whereas we want deliberate re-lookup.

### Option B — Git-ignore `cdk.context.json` (chosen)

Every synth re-queries AWS.

- Pros: No account identifiers in the public repo. Every synth reflects live AWS state — staleness is impossible. Fits our "few deploys, expect experimentation" workflow.
- Cons: Non-reproducible builds — CI and laptop may synthesise different templates if AWS state differs. Requires AWS credentials for every synth (mitigated because [ADR-0005](0005-local-first-development-with-kind.md) means we synth infrequently).

### Option C — Encrypt and commit

Commit an encrypted (SOPS/age) version of `cdk.context.json`.

- Pros: Reproducibility without leakage.
- Cons: Adds a decryption step to every `cdk synth`. Overkill for the sensitivity level (context data is not, strictly, secret).

### Option D — Per-environment context files

`cdk.context.eu-west-1.json`, `cdk.context.us-east-1.json`, etc., manually curated.

- Pros: Fine-grained control.
- Cons: Manual maintenance burden. Not a CDK-supported pattern.

## Decision

We chose **Option B — git-ignore `cdk.context.json`**. The three project-specific factors that flip the default are: (a) public repo makes even mildly sensitive account IDs undesirable, (b) low deploy count makes reproducibility a marginal win, (c) learning workflow requires switching AWS accounts/regions freely — a pinned context would silently break.

**In a production team setting, we would flip this decision and commit the file** — plus add it to `CODEOWNERS`, plus add a CI check that fails if it's out of date. That is the mature production setup. The reasoning for choosing differently here is entirely about the *portfolio context*, not the *technical merits*.

## Consequences

- **Positive:** No account identifiers in the public repo. Every synth reflects current AWS state. Simpler onboarding — no `cdk.context.json` merge conflicts.
- **Negative:** CDK synth requires AWS credentials every time. CI cannot synth offline. Snapshot tests may be flaky if AWS state shifts between test runs.
- **Neutral:** `cdk.context.json` remains a working file locally; it just doesn't enter Git history.

## When to revisit

- If we switch to a private repo where identifier leakage is not a concern.
- If synth frequency grows to the point that reproducibility becomes valuable.
- If we adopt this project as a team project — the reproducibility of committed context becomes worth the trade-off.

## Related decisions

- [ADR-0002](0002-use-aws-cdk-for-baseline-infra.md) — the CDK choice this ADR annotates.
- [ADR-0005](0005-local-first-development-with-kind.md) — low deploy frequency reduces the reproducibility win.

## References

- [AWS CDK: Runtime context](https://docs.aws.amazon.com/cdk/v2/guide/context.html) — official recommendation to commit
