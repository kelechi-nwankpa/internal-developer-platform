# 0026 — Install Crossplane core (chart 1.20.11, v1 track) as one ArgoCD Application

- **Status:** Accepted
- **Date:** 2026-08-05
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 4 needs the Kubernetes-native infrastructure API — Crossplane. Two immediate decisions:

1. **Which Crossplane track: v1 or v2?** Crossplane 2.0 shipped in early 2026 with substantial breaking changes (namespace-scoped composite resources by default, functions-only rendering, XRC concept removed). Both v1 and v2 are actively maintained (v1.20.11 and v2.3.4 both shipped 2026-07-23).
2. **How to install it?** Helm chart via ArgoCD (established pattern per ADR-0016) is the obvious answer; recording it here for completeness.

The install itself is trivial — Crossplane core is a small operator with sensible chart defaults. The interesting content of this ADR is the v1-vs-v2 decision and the rationale for the "install now, ship providers separately" phasing.

## Decision drivers

1. **Ecosystem maturity.** Providers (family-aws, aws-s3, aws-rds, aws-iam, and dozens of non-AWS) all have first-class v1 support. v2 support is spotty — some providers are v2-native, others still v1-first.
2. **Documentation alignment.** Every Crossplane tutorial, blog post, and community example assumes v1. v2 docs exist but are much thinner.
3. **Portfolio project vs bleeding edge.** Portfolio value comes from matching real-world adoption, not being the first to demonstrate v2.x. v1 is what running Crossplane deployments look like today.
4. **Migration path.** Moving from v1 to v2 later is a well-documented upgrade (XRs need re-scoping if you had cluster-scoped, patch-and-transform Compositions need rewriting as functions). Not free but not blocking.
5. **Phase 6 golden paths depend on this working.** Backstage will render XRCs when developers click "New service." Whatever we pick has to work smoothly with the providers we install.

## Options considered

### Option A — Crossplane v1.20.x (chosen)

Chart `1.20.11` (latest v1.20 patch, released 2026-07-23), matching app v1.20.11.

- Pros: Ecosystem-wide compatibility. Every AWS provider supports v1. Every tutorial + community answer applies. Cluster-scoped composite resources with namespace-scoped XRCs is well-understood. Patch-and-transform Compositions AND function-based Compositions both work — pick per Composition. 12 patch releases in the v1.20.x series so far — well-soaked.
- Cons: Cluster-scoped XRs are arguably confusing for multi-tenant clusters (all XRs in one namespace-less pool). v1 will eventually be deprecated (unknown timeline).

### Option B — Crossplane v2.x

Chart `2.3.4` (latest).

- Pros: Cleaner mental model (namespace-scoped composite resources are more intuitive, XR/XRC merged into just XR, functions are the only rendering path). Modern. Where the project is headed.
- Cons: Provider ecosystem hasn't fully caught up. Some providers are v2-native, some are v1-first. Every tutorial we'd read is v1-flavoured — cognitive overhead of "translating" between versions. Migration for XRs written in v1 shape is non-trivial. **Community answers on Stack Overflow / GitHub Issues almost always assume v1** — every debug session would start with "am I on v2? does this answer apply?"

### Option C — Wait entirely

Don't install Crossplane in Phase 4. Delay to a later phase when v2 is dominant.

- Pros: Skip the "obsolete v1" concern.
- Cons: **Blocks Phase 5 (Backstage golden paths).** Backstage's whole appeal is one-click infra provisioning; without Crossplane there's nothing to provision. Rejected.

## Decision

**Option A — v1.20.11.**

Ecosystem maturity outweighs the "modern mental model" argument at this stage. Every provider we'll install (provider-family-aws, provider-aws-s3, provider-aws-iam) is v1-first. Every community answer we'd look up assumes v1. When v2.x has broad provider coverage — probably 6-12 months out — migration is a Phase 8+ concern.

**Chart version: `1.20.11`.** Latest v1.20 patch (2026-07-23). Chart maintainers ship patches for both v1 and v2 tracks in lockstep — v1.20.x has 12 patch releases so far, well-soaked. Same "pin latest patch in the same minor" pattern as every other component we've installed.

## Consequences

- **Positive:** Every Crossplane tutorial + community answer applies. All AWS providers work first-class. Two rendering paths available (patch-and-transform for simple Compositions, functions for complex ones) — pick per Composition. Straightforward install with zero required values overrides.
- **Negative:** Cluster-scoped XRs need namespace-scoped XRCs (Claims) to give consumers a per-namespace API surface. Small cognitive overhead vs v2's cleaner scoping. Migration to v2 in the future is real work (XR re-scoping + patch-and-transform → functions rewrite for any Composition still using the legacy path).
- **Neutral:** Crossplane core is a single pod. Almost no resource overhead. Chart defaults are sensible for kind and for prod — no values overrides at install time.

## When to revisit

- **When v2.x provider ecosystem catches up** — most AWS providers become v2-native, community answers on Stack Overflow / GitHub Issues shift to v2-first. Estimated 6-12 months. Migration ADR at that point.
- **If we hit a specific v2-only feature we need** (unlikely for our Phase 4/6 scope, but possible if we adopt a v2-only provider or function).
- **If v1 gets an EOL announcement** — Crossplane maintainers have historically supported n-2 minors; v1.20 will get patches until v1.22 ships. Not an imminent concern.

## Related decisions

- [ADR-0016](0016-cert-manager-install-via-helm.md) — the "Helm via ArgoCD Application" install pattern this ADR follows.
- Future ADR-0027 (pending) — the first XRD + Composition design (Task 4.4). ObjectBucket XRD chosen for the demo XRD (S3 is simplest).
- Future ADR — the Crossplane provider install (Task 4.3). Family-aws + S3 + IAM chosen for the initial cut per Phase 4 intro.
- [ADR-0010](0010-fargate-only-eks-cluster.md) — Fargate-only EKS constrains where Crossplane runs on EKS in Phase 9 (must be Fargate-compatible, which Crossplane is).

## References

- [Crossplane v1.x docs](https://docs.crossplane.io/v1.20/)
- [Crossplane v1 vs v2 migration guide](https://docs.crossplane.io/v2.0/migration/)
- [Crossplane Helm chart README](https://github.com/crossplane/crossplane/blob/main/cluster/charts/crossplane/README.md)
- [provider-family-aws and Upbound's Upjet-generated AWS providers](https://marketplace.upbound.io/providers/upbound/provider-family-aws)

## Interview framing

The one-liner: *"Crossplane is the Kubernetes-native infrastructure API — every AWS resource becomes a k8s CR that developers `kubectl apply`, and platform teams wrap those raw resources in higher-level abstractions (XRDs) exposed as their own developer-facing API. We install core Crossplane v1.20.11 as a single ArgoCD Application — v1 over v2 because the provider ecosystem is still v1-first and every community answer assumes v1. Migration to v2 is Phase 8+ concern once the ecosystem shifts. On kind we install everything but skip real ProviderConfig with AWS creds — Composition validation via `crossplane render` (dry-run) proves the interesting logic without needing AWS access. Full end-to-end provisioning waits for Phase 9 EKS with IRSA."*
