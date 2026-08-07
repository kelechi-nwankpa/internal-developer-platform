# 0027 — First XRD (ObjectBucket): API surface, Composition pattern, naming

- **Status:** Accepted
- **Date:** 2026-08-07
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 4 pivoted the platform from operating infra to *offering it as an API*. [ADR-0026](0026-crossplane-install-and-version.md) installed Crossplane core + AWS providers; Task 4.4 defines the first XRD — the shape a developer sees when they consume the platform.

Four decisions crystallise the developer-facing contract:

1. **Which fields go in v1alpha1?** Every field is a public API commitment. Add later; remove is hard.
2. **Which MRs does the Composition render?** Every MR is an operational cost and a security surface.
3. **How is the S3 bucket named?** S3 bucket names are globally unique — must be collision-safe.
4. **Which Composition rendering mode?** Pipeline-of-Functions vs legacy patch-and-transform.

## Decision drivers

1. **API narrowness.** A v1alpha1 with 3 fields is a v2 with 3 fields is a v1 with 3 fields — none of them break customers. A v1alpha1 with 15 fields locks us into supporting all 15 for the API's lifetime.
2. **Secure by default.** Every MR the Composition renders should default to "safe" — not "convenient for developers."
3. **Bucket naming is a real constraint.** S3 bucket names are globally unique across all AWS accounts. Collisions are hard failures at creation time.
4. **Chart-native / community-standard patterns.** Composition Functions (v1.11+) are the modern rendering path. Legacy patch-and-transform is being removed in v2.x.
5. **Portfolio narrative — the developer's XRC should look simple.** A 3-field YAML with sensible defaults is worth more than a 15-field one with opaque semantics.

## Options considered

### Decision 1: API fields for v1alpha1

**Option A — Minimal 3 fields (chosen):** `region` (enum, required), `publicRead` (bool, default false), `versioning` (bool, default false)

- Pros: Every field is opinionated; developer choice is meaningful. Locks in secure defaults. Removes surface where "which does this actually do?" ambiguity would grow.
- Cons: Real workloads may want more (lifecycle rules, replication, notification, CORS). All addable in v2.

**Option B — Comprehensive 10+ fields:** everything a raw S3 Bucket exposes.

- Pros: Developers never need to escape the abstraction.
- Cons: If we can express all of raw S3, we haven't actually simplified anything. The abstraction adds complexity (learn the XRD + learn S3) instead of removing it. Bloat.

### Decision 2: MRs the Composition renders

**Option A — 4 MRs with conditional rendering (chosen):**

- `Bucket` (always)
- `BucketPublicAccessBlock` (unless `publicRead: true` — locks down anonymous access)
- `BucketVersioning` (if `versioning: true`)
- `BucketServerSideEncryptionConfiguration` (always — AES256 opinionated default)

- Pros: Secure by default (PAB + SSE always-on unless explicitly opted out). Composition function conditional syntax handles the choice cleanly. Every rendered MR has an obvious mapping to a developer field.
- Cons: `publicRead: true` skips the PAB — the "opt out of safe" needs to be documented as an active risk.

**Option B — Bucket only, everything else via post-creation MRs the developer applies:**

- Pros: Simpler Composition.
- Cons: Every consumer would have to know to apply BucketPublicAccessBlock manually. Defeats the abstraction.

**Option C — All 8+ MRs S3 offers (BucketOwnership, BucketAccelerateConfiguration, BucketLogging, ...):**

- Pros: Full coverage.
- Cons: Bloat. Most aren't useful for a first pass.

### Decision 3: bucket naming

**Option A — Auto-generated `<claim-name>-<6-char-suffix>` (chosen):**

- Pros: Collision-safe. No user-facing field required. Suffix derived from XR UID (stable across reconciles). Meaningful for debug — bucket name matches claim name.
- Cons: Long-ish bucket names (S3 limit is 63 chars, most claims well within).

**Option B — User supplies `spec.bucketName`:**

- Pros: Explicit naming.
- Cons: Collision risk (S3 names are global). Users would have to invent collision-avoidance conventions. Adds a required field.

**Option C — Namespace + claim name (`<namespace>-<name>`):**

- Pros: Collision-safe within one AWS account. Meaningful.
- Cons: Namespace names can contain characters S3 rejects. Two AWS accounts using this pattern could still collide (unlikely for our single-account portfolio, real problem for multi-account).

### Decision 4: Composition rendering mode

**Option A — Pipeline-of-Functions using fn-go-templating + fn-auto-ready (chosen):**

- Pros: Modern Crossplane pattern (v1.11+). Full Go template expressiveness (loops, conditionals, computed values). Familiar syntax if you know Helm. All community docs assume this. Forward-compatible with v2 (patch-and-transform is deprecated).
- Cons: Requires Function packages installed as separate CRs (done in Task 4.4.b). Rendering happens in an out-of-process pod call — small latency overhead vs in-controller patching.

**Option B — Legacy patch-and-transform:**

- Pros: In-controller, no separate pod. Lower latency per reconcile.
- Cons: Deprecated in v2.x — will be removed. Cumbersome for anything beyond straightforward field mapping (deeply nested patches). Verbose YAML.

## Decision

**Option A on all four:** minimal 3-field API, 4 conditionally-rendered MRs with secure defaults, auto-generated bucket names (`<claim>-<6char>`), Pipeline mode with fn-go-templating + fn-auto-ready.

**Version pinned to `v1alpha1`.** `alpha` explicitly signals API instability — we may add/rename fields in `v1beta1` or `v1` as real consumer usage teaches us what's actually needed.

## Consequences

- **Positive:** Small, opinionated API. Secure by default (PAB + SSE always-on). Developer YAML fits in 8 lines. Bucket names collision-safe. Composition uses modern Function pipeline — forward-compatible with v2.x. Every field is meaningful.
- **Negative:** Real workloads may need fields we don't offer (lifecycle rules for cost management, replication for DR, notifications for event triggers). All addable in v2. In the meantime, teams that need those escape hatches would fall back to raw S3 MRs (which we still allow — the XRD is one abstraction, not the only path).
- **Neutral:** `providerConfigRef: default` in every MR. On kind there's no `ProviderConfig/default` (per ADR-0026) — MRs will fail to reconcile, which is exactly the expected state. `crossplane render` (Task 4.4.e) validates the Composition logic without needing this. On Phase 9 EKS, a `ProviderConfig/default` with IRSA activation makes everything real.

## The Composition patterns to remember

### Bucket naming — stable-suffix pattern

```go-template
{{- $uid := $xr.metadata.uid | default "" -}}
{{- $suffix := (substr 0 6 ($uid | replace "-" "")) | default (randAlphaNum 6 | lower) -}}
```

- Prefer deterministic (UID-derived) → same claim always gets same bucket name on re-render.
- Fall back to random only if UID unavailable during first render.

**Anti-pattern:** just `randAlphaNum` — every reconcile generates a different suffix, provider tries to delete-and-recreate the bucket, everything churns.

### Conditional rendering — the `{{- if ... }}` pattern

```go-template
{{- if not $spec.publicRead }}
---
apiVersion: s3.aws.upbound.io/v1beta1
kind: BucketPublicAccessBlock
...
{{- end }}
```

**Pattern:** every MR that's conditionally rendered wraps in `{{- if ... }}` / `{{- end }}`. The `{{-` (with trailing dash) strips whitespace so the template doesn't emit blank lines when the condition is false.

### Composition-resource-name annotation — required by fn-go-templating

Every MR the template emits needs:

```yaml
annotations:
  gotemplating.fn.crossplane.io/composition-resource-name: <unique-slot-name>
```

Without this, fn-go-templating errors out ("no composition-resource-name annotation"). Slot names must be unique per composition; used by fn-auto-ready to correlate MR status back to the XR.

### `crossplane.io/external-name` for cloud-side naming

```yaml
metadata:
  name: {{ $xr.metadata.name }}                           # k8s object name (matches XR)
  annotations:
    crossplane.io/external-name: {{ $bucketName }}        # AWS-side name
```

**Two names.** k8s object name is what `kubectl get` sees; external-name is what appears in AWS. Without external-name, provider uses metadata.name for both — which fails for globally-unique resources like S3 buckets when the same claim exists in multiple namespaces.

## When to revisit

- **When a real consumer asks for a field we don't have.** Add to v1beta1 or v1. Announce as an additive change. Never remove; deprecate + document migration.
- **When Crossplane v2.x forces a migration.** Composition Pipeline API may change; patch-and-transform will be removed. Test in a scratch cluster before bumping.
- **When we add Phase 8 hardening.** Access logging, CloudTrail audit, lifecycle policies with mandatory tags for cost attribution — all become new required MRs in the Composition.
- **When Phase 6 golden paths generate ObjectBucket claims.** Real developer usage will show which of the 3 fields is confusing or missing. Iterate then.

## Related decisions

- [ADR-0026](0026-crossplane-install-and-version.md) — Crossplane core install (v1 track, chart 1.20.11) that this XRD depends on.
- [ADR-0004](0004-single-region-with-multi-region-readiness.md) — single-region posture constrains the `region` enum to `eu-west-1` primarily; `us-east-1` included for room.
- [ADR-0011](0011-ecr-immutable-tags-per-domain-repos.md) — similar API narrowness discipline (immutable tags, per-domain repos) — Phase 1 established the pattern this XRD follows.
- Future ADR — Namespace XRD (Task 4.6), our second XRD. Different shape (no cloud API involvement); contrast with ObjectBucket.

## References

- [Crossplane Composition Functions](https://docs.crossplane.io/v1.20/concepts/composition-functions/)
- [function-go-templating docs](https://github.com/crossplane-contrib/function-go-templating)
- [function-auto-ready docs](https://github.com/crossplane-contrib/function-auto-ready)
- [Crossplane external-name annotation](https://docs.crossplane.io/v1.20/concepts/managed-resources/#external-name)
- [XRD schema conventions](https://docs.crossplane.io/v1.20/concepts/composite-resources/)

## Interview framing

The one-liner: *"Our first Crossplane XRD is `ObjectBucket` — an S3 bucket abstraction with 3 fields (region, publicRead, versioning). Composition renders 4 MRs conditionally: Bucket (always), PublicAccessBlock (unless opted out), Versioning (if enabled), SSE (always AES256). Bucket names auto-generated from claim UID for collision-safety. Modern Pipeline mode with fn-go-templating + fn-auto-ready — no legacy patch-and-transform. Deliberately narrow API for v1alpha1: 3 fields you can't misuse beats 15 you can. On kind we validate via `crossplane render` (no AWS needed); Phase 9 EKS activates real bucket creation via IRSA-authed ProviderConfig."*
