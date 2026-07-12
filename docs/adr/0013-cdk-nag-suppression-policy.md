# 0013 — cdk-nag suppression policy

- **Status:** Accepted
- **Date:** 2026-07-12
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Every stack in this project runs through `cdk-nag`'s `AwsSolutionsChecks` ruleset at synth time (wired up in `bin/idp.ts`). Some rules fire on resources we don't own — for example, the `AmazonEKSClusterPolicy` managed policy that AWS mandates on the EKS cluster service role, or the CDK Provider Framework Lambda handlers with `<arn>:*` wildcards for version invocation.

Ignoring those findings silently — via a blanket `suppressAllErrors` or by turning off cdk-nag entirely — is worse than useless. It hides real issues in a wash of noise and gives us no audit trail. Fixing everything is impossible because some rules are effectively "AWS require this."

We need a **policy** for how findings are handled: what gets fixed, what gets suppressed with rationale, and what gets deferred.

## Decision drivers

- Reviewers should be able to read *why* every suppression exists without inspecting the code.
- Suppressions should be scoped as tightly as possible (per-resource, with `appliesTo`) so that a future edit adding a similar violation *elsewhere* still gets flagged.
- Every suppression must include an interview-defensible reason. `"CDK generates this"` is not enough — the reason must explain what's actually happening and why the finding is not a real problem here.
- The volume of noise from cdk-nag should not train the team to ignore it.

## Options considered

### Option A — No suppressions, fix everything

Only accept designs where zero cdk-nag findings fire.

- Pros: Cleanest audit story.
- Cons: Impossible. `AmazonEKSClusterPolicy` cannot be replaced. Half of CDK's L2 constructs would need to be rebuilt to satisfy every rule. Optimising for zero findings would force us to write worse code (raw L1 constructs everywhere).

### Option B — Blanket global suppressions

Suppress classes of findings project-wide via `NagSuppressions.addStackSuppressions(app, [...])` at App level.

- Pros: Simple.
- Cons: Hides real violations *anywhere* in the codebase. A wildcard added to a policy in a new stack would slip through unnoticed. Removes the safety benefit of running cdk-nag at all.

### Option C — Per-resource suppressions with written reasons (chosen)

Attach each suppression to the specific construct that produces the finding, with a human-readable reason field. Use `appliesTo` when the finding is granular enough to identify specific policies or resources.

- Pros: Any future addition triggers a fresh finding. Reasons are readable in code. Suppression path traceable via CloudFormation logical IDs. Reviewers can scan the reasons in seconds.
- Cons: More typing. Reasons must be maintained if constructs change.

### Option D — Turn cdk-nag off in CI, run it manually as a periodic audit

- Pros: No suppression maintenance.
- Cons: Immediately drifts from "should be clean" to "was clean when I checked in September." Same failure mode as blanket suppress.

## Decision

**Option C — per-resource suppressions with written reasons.**

For every cdk-nag finding, categorise into one of four buckets:

| Bucket | Action | Example |
|---|---|---|
| **Bug in our code** | Fix by editing the stack | Wildcard we added ourselves |
| **AWS-mandated** | Suppress with reason "AWS API requires this" | `AmazonEKSClusterPolicy` |
| **CDK-internal plumbing** | Suppress with reason "attached by CDK Provider Framework / L2 construct we don't own" | `<lambda-arn>:*` on Provider handlers |
| **Deliberate architectural choice** | Suppress + link to the ADR that documents the trade-off | `EKS1` on our public endpoint (see ADR-0010) |

Every suppression's `reason` field must:

1. Name the resource(s) or policy(ies) involved.
2. Explain *why* the finding is not fixable without a bigger design change.
3. Where relevant, reference the ADR that documents the choice.

`appliesTo` should be used when the rule is granular. If the resulting string list would be unstable (e.g., contains CDK-generated logical IDs), scope the suppression to a specific construct via `addResourceSuppressions(construct, ...)` instead of naming individual policies.

### Nested-stack gotcha (learned the hard way)

CDK's aws-eks L2 construct places its Provider Framework Lambda handlers + Step Function in a **separate nested stack**. `NagSuppressions.addResourceSuppressions(construct, ..., applyToChildren: true)` does **not** cross nested-stack boundaries — the recursion stops at the nested-stack construct.

The fix, for any construct whose L2 uses nested stacks (`Cluster`, `Bucket` with deployments, etc.):

```typescript
NagSuppressions.addStackSuppressions(this, [...], true /* applyToNestedStacks */);
```

`addStackSuppressions` with the third arg set to `true` cascades into every nested stack the current stack owns. Prefer this over `addResourceSuppressions` whenever the flagged resource lives inside CDK's Provider Framework or any construct that provisions a nested stack.

## Consequences

- **Positive:** Every finding is either fixed or explained. Reviewers can audit the security posture by scanning suppression reasons. Future edits that introduce fresh violations still get flagged.
- **Negative:** ~150 lines of suppression code across the project (concentrated in `ClusterStack`, where CDK's aws-eks L2 does the most work behind the scenes). Reasons need to be updated if CDK reshapes internal constructs.
- **Neutral:** No cdk-nag-related CI enforcement yet. Task 1.11's Makefile will wire `cdk synth` into `make lint` so a fresh violation shows up locally before CI.

## When to revisit

- If cdk-nag introduces new rules that reduce our current suppression list to a smaller subset.
- If AWS ships replacement narrow-scope policies for `AmazonEKSClusterPolicy` etc.
- If we adopt a stricter ruleset (`NIST80053R5`, `HIPAA`) that requires re-audit.
- If suppression maintenance becomes a real burden (>50 entries, refactor to a suppression manifest file).

## Related decisions

- [ADR-0010](0010-fargate-only-eks-cluster.md) — the ClusterStack whose CDK L2 construct is the source of ~90% of cdk-nag findings.
- Every future stack should start by running `cdk synth` locally and checking for new findings before commit.

## References

- [cdk-nag docs — suppressions](https://github.com/cdklabs/cdk-nag/blob/main/README.md#suppressing-a-rule)
- [cdk-nag AwsSolutions rules](https://github.com/cdklabs/cdk-nag/blob/main/RULES.md#awssolutions)
- [AWS docs — Amazon EKS service-linked roles](https://docs.aws.amazon.com/eks/latest/userguide/using-service-linked-roles.html)
