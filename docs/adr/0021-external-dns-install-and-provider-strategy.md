# 0021 — Install ExternalDNS via Helm; inmemory provider on kind, Route53 via IRSA on EKS

- **Status:** Accepted
- **Date:** 2026-08-03
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 2 needs a controller that materialises DNS records from Kubernetes resources (Ingress, Service). ExternalDNS is the accepted community solution — same problem shape as cert-manager (declarative TLS) and ESO (declarative secrets).

The interesting decision isn't *whether* to install ExternalDNS — it's *what provider to configure on kind*, since kind has no external routing. Unlike cert-manager (SelfSigned issuer worked cleanly for kind) or ESO (Vault-in-kind gave a real backend), ExternalDNS's *whole purpose* is external — a DNS record on kind that no external DNS query can reach is close to meaningless.

Four honest paths for the kind side, one Phase-9 path for EKS.

## Decision drivers

1. **Proves the wiring on kind.** We want ExternalDNS installed and running so `kubectl` operations, RBAC, Application manifests, and log observability all exercise. The DNS backend can be dry-run without losing the demonstration.
2. **No AWS credentials on a laptop.** Same hygiene rule as ADR-0019 for ESO. Static AWS creds in a Kubernetes Secret is an anti-pattern.
3. **Migration to real Route53 on EKS is a values-only change.** Same file, swap provider, add IRSA annotations. No Application rewrite.
4. **Domain scoping.** Whatever provider is configured, `domainFilters` must lock ExternalDNS to `idp.seniormankelz.dev` — otherwise a stray annotation could touch unrelated zones (or attempt to).
5. **Consistency with prior operators.** Helm-via-ArgoCD, config in `platform/argocd/apps/`, ADR pattern.

## Options considered

### Environment: kind

#### Option A — Full skip on kind

Install nothing on kind; ExternalDNS ships fresh with the EKS deploy in Phase 9.

- Pros: Cleanest narrative — no half-shipped operator. Reduces surface on kind.
- Cons: Loses "we have DNS management" from the local platform story. First `git push` in Phase 9 has more to prove because nothing was validated on kind.

#### Option B — Install with `inmemory` provider (chosen)

ExternalDNS runs, watches Ingress + Service, but writes intended records to an in-memory store and logs what it *would* do. No external DNS touched.

- Pros: **Proves the entire reconciliation loop end-to-end** — controller watches, computes desired state, "applies" (to inmemory). Values overrides + RBAC + Application manifest all real. Migration to Option D on EKS = swap `provider.name` + add IRSA. Zero external side effects, no cleanup, no cost.
- Cons: Records don't actually resolve. Portfolio narrative needs an explicit "on kind this is dry-run" note (which is exactly what ADR-0021 provides).

#### Option C — Real Route53 with static AWS creds in a Secret

ExternalDNS on kind talks to real Route53 in eu-west-1 with credentials in a Kubernetes Secret.

- Pros: Actual DNS records exist. Full end-to-end.
- Cons: Static AWS creds on a dev laptop — the well-established anti-pattern rejected at ADR-0019 for ESO. Real DNS records leak from dev to prod-visible zone. Same rejection.

#### Option D — CoreDNS as provider

ExternalDNS can write to CoreDNS via its etcd-backed plugin.

- Pros: Real DNS records inside the cluster. Interesting for service discovery.
- Cons: Records only resolvable inside the cluster (not from a browser). Narrow use case that doesn't help the "Ingress → public HTTPS URL" story. Additional setup (CoreDNS etcd plugin, custom Corefile) for weak portfolio value.

### Environment: EKS (Phase 9, deferred)

#### Option E — AWS Route53 via IRSA (planned)

Real Route53. ExternalDNS ServiceAccount annotated with an IRSA role that permits `route53:ChangeResourceRecordSets` on the `idp.seniormankelz.dev` hosted zone specifically.

- Pros: Native AWS. IAM-scoped access (specific hosted zone, specific actions). CloudTrail audit. Integrates with the DnsStack from Phase 1 and the IRSA pattern from ADR-0009.
- Cons: Requires the EKS cluster + DnsStack deployed + IAM role. Phase 9 work.

## Decision

**Matrix decision:**

| Environment | Provider | Auth |
|---|---|---|
| kind (local dev, now) | `inmemory` | none |
| EKS (Phase 9) | `aws` (Route53) | IRSA + scoped IAM role |

**Same Application file** (`platform/argocd/apps/external-dns.yaml`) works for both. Phase 9 migration = swap `provider.name: inmemory` → `provider.name: aws`, add `serviceAccount.annotations` for IRSA, add `env` for `AWS_REGION`. Everything else — RBAC, sources, policy, txtOwnerId — stays.

**`domainFilters` set now** even though it has no security effect for inmemory. Two reasons: (a) it documents the intended production scope inline so Phase 9 doesn't require thinking about it; (b) the txtOwnerId + domainFilter combination is what makes multi-environment ExternalDNS safe when we eventually add staging alongside prod.

## Consequences

- **Positive:** Real operator runs on kind. Every Application manifest, RBAC binding, values override, and reconciliation cycle is exercised. Log observability during manual test (Task 2.5.e) shows exactly what ExternalDNS would do. Migration to Phase 9 is a small YAML diff, not a rewrite. Consistent pattern with cert-manager and ESO (Helm-via-ArgoCD, `inmemory`/dev-mode backend on kind, real backend on EKS).
- **Negative:** Records don't actually resolve on kind. If we ever set up a scenario where local DNS actually matters (Ingress-with-real-cert story), we'd need to upgrade the provider then. Also: inmemory's state is truly ephemeral — every ExternalDNS pod restart forgets everything, no persistence like Vault's PVC or Route53's cloud storage.
- **Neutral:** `txtOwnerId: idp-kind-dev` chosen to distinguish this instance from any future ExternalDNS deployment. When Phase 9 EKS ships, its owner ID becomes `idp-eks-prod` (or similar) — running both in parallel would produce clean, non-conflicting TXT records.

## When to revisit

- **Phase 9 EKS activation.** Swap provider to `aws`, add IRSA annotations, verify Route53 records materialise. `domainFilters: [idp.seniormankelz.dev]` already in place.
- **If we need local DNS resolution on kind** (e.g., a demo where a browser must resolve a name to the kind cluster). Then consider CoreDNS-provider + coredns-corefile customization, or point local resolver at CoreDNS. Unlikely — port-forward + localhost:port suffices for our workflows.
- **If ExternalDNS's release cadence changes materially.** Right now it's slow (months between minors). If they start shipping monthly, revisit the "wait for community soak" default from Task 2.5.b.
- **If we adopt a non-AWS DNS provider** (Cloudflare, GCP DNS, DigitalOcean) as the primary. Then a second Application `external-dns-<provider>.yaml` with a different `txtOwnerId` — both can coexist, each managing distinct zones.

## Related decisions

- [ADR-0012](0012-subdomain-delegation-for-idp.md) — Namecheap → Route53 subdomain delegation. ExternalDNS's Phase 9 activation targets this zone.
- [ADR-0009](0009-github-oidc-federation.md) — IRSA pattern that ExternalDNS's Phase 9 ServiceAccount will reuse.
- [ADR-0017](0017-cert-manager-issuer-strategy.md) — cert-manager DNS-01 also needs Route53 access; both operators share the same IAM constraint on Phase 9.
- [ADR-0018](0018-external-secrets-install-via-helm.md) + [ADR-0019](0019-vault-install-for-eso-kind-backend.md) — same "install-and-configure-minimally-on-kind, activate-fully-on-EKS" pattern.

## References

- [ExternalDNS Helm chart values reference](https://artifacthub.io/packages/helm/external-dns/external-dns)
- [ExternalDNS — inmemory provider (test/dev)](https://kubernetes-sigs.github.io/external-dns/latest/docs/tutorials/dev-notes/)
- [ExternalDNS — AWS Route53 setup (Phase 9)](https://kubernetes-sigs.github.io/external-dns/latest/docs/tutorials/aws/)
- [ExternalDNS — TXT registry + owner ID](https://kubernetes-sigs.github.io/external-dns/latest/docs/faq/)

## Interview framing

The one-liner: *"ExternalDNS on kind runs in inmemory-provider mode — the operator, RBAC, and reconciliation loop are all real; only the DNS backend is dry-run. Same file activates real Route53 on EKS in Phase 9 by swapping `provider.name: inmemory` to `provider.name: aws` and adding IRSA annotations to the ServiceAccount. The `domainFilters: [idp.seniormankelz.dev]` and `txtOwnerId` are set now so migration is a values-only change, not an Application rewrite. Cleanest way to prove the wiring on a local cluster where real DNS has nowhere to point."*
