# 0017 — cert-manager ClusterIssuer strategy: SelfSigned on kind, Let's Encrypt on EKS

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

[ADR-0016](0016-cert-manager-install-via-helm.md) installed the cert-manager operator. But installation is inert — the operator watches `Certificate` CRs and reconciles them against an `Issuer` or `ClusterIssuer`. Without an issuer configured, cert-manager is a controller with nothing to do.

We need to decide **which certificate authorities cert-manager will use** across our two environments:

- **kind (local dev)** — no public IP, no owned public DNS pointing at this cluster, possibly offline, must be cheap to iterate on.
- **EKS (staging/prod, Phase 9)** — real public services, need browser-trusted certs, integrates with Route53 (from [Phase 1's DnsStack](../adr/0012-subdomain-delegation-for-idp.md)) and IAM (from [ADR-0009's IRSA pattern](0009-github-oidc-federation.md)).

Same operator, same CRDs, different issuers per environment. The decision is what mix of issuers to configure now (in git, applied via GitOps), and what to defer.

## Decision drivers

1. **Zero external dependencies on kind.** The local dev loop must work offline, without network calls to CAs, without owning a public DNS pointing at the cluster.
2. **Zero cost on kind.** No burning Let's Encrypt rate-limit quota during dev churn.
3. **Real trust on EKS.** Anything user-facing must serve a browser-trusted cert.
4. **Progressive activation, not rewriting.** Same manifest file(s) should evolve from kind → EKS by enabling additional issuers, not replacing what's there.
5. **Rate-limit discipline.** LE production is strict — 50 issued certs per registered domain per week. Any workflow that regenerates certs on every deploy will exhaust quota in a day. Staging must be used for anything churny; prod only for real-world stable services.
6. **Private key material never leaves the cluster.** cert-manager's model already guarantees this (CSR sent to CA, key material never leaves); the choice of issuer doesn't change that property, but any DNS-01 solver that requires cloud credentials must use IRSA (not static keys in Secrets).

## Options considered

### Option A — SelfSigned ClusterIssuer only (chosen for kind)

Every Certificate that references this ClusterIssuer gets a fresh self-signed cert. No CA registration, no ACME flow, no DNS validation, no network calls.

- Pros: Zero external dependencies. Works offline. Costs nothing. Exercises the entire cert-manager pipeline (Certificate → CertificateRequest → Order → cert bytes → Secret) with real X.509 material — identical wiring to what a Let's Encrypt issuer would trigger. **Perfect kind-dev issuer.**
- Cons: Browsers show "not trusted" warnings. Not usable for public-facing services. Certs don't chain to any recognisable root.

### Option B — Internal `CA` ClusterIssuer (with a bootstrap SelfSigned CA cert)

Generate a root CA cert (self-signed once), then use `CA` ClusterIssuer to sign further certs off that root. Optionally distribute the root to client trust stores.

- Pros: Scriptable client trust (add the root to macOS keychain, browsers trust everything signed by that root). Cert chains look real.
- Cons: Root cert management (rotation, secret handling) adds ops overhead. For kind-dev the payoff (removing browser warnings) doesn't justify the complexity — the warnings during local testing are informative, not annoying.

### Option C — ACME (Let's Encrypt Staging) via HTTP-01 challenge

Real ACME flow to LE's staging server. HTTP-01 challenge: cert-manager responds to a token on `http://<domain>/.well-known/acme-challenge/...`.

- Pros: Real ACME rehearsal without burning prod quota.
- Cons: **Impossible on kind.** HTTP-01 requires a public IP for the domain; kind runs locally with no public routing. And even on EKS, HTTP-01 requires the workload be publicly reachable on port 80, which conflicts with our HTTPS-only, `.dev`-HSTS-preloaded posture.

### Option D — ACME (Let's Encrypt Staging) via DNS-01 challenge (chosen for EKS staging)

Real ACME flow to LE's staging server. DNS-01 challenge: cert-manager creates a `_acme-challenge.<domain>` TXT record; LE queries it; if present, cert issued.

- Pros: Works without public HTTP access — DNS-01 doesn't require the target service to be reachable. Wildcard certs (`*.idp.seniormankelz.dev`) are only issuable via DNS-01. Rehearses the full production flow. Generous rate limits (30,000 certs per week per account on staging).
- Cons: **Needs credentials to write DNS records.** For Route53 (our DNS provider from Phase 1), cert-manager needs IAM permissions on the hosted zone. On EKS this is IRSA (well-established pattern per [ADR-0009](0009-github-oidc-federation.md)). On kind, DNS-01 to Route53 would require AWS static creds in a Secret — a bad pattern we're not adopting.

### Option E — ACME (Let's Encrypt Production) via DNS-01 (chosen for EKS prod)

Same shape as D but points at LE's production ACME endpoint. Certs are browser-trusted.

- Pros: Real trusted certs.
- Cons: Strict rate limits (50 issued certs per registered domain per week; 5 duplicate certs per week). Any workflow that regenerates certs on every deploy will burn quota fast. Must be gated behind LE-staging validation.

### Option F — Vault as issuer

HashiCorp Vault as a private CA, cert-manager issues off Vault via the `Vault` issuer type.

- Pros: Deep secret-lifecycle control; short-lived certs (24h TTL) become practical for mTLS. Used in real-world enterprise deployments.
- Cons: Vault is not deployed. Not in Phase 2 scope. Would be its own operator install + Vault operator + storage backend etc. Overkill until we have mTLS requirements (Phase 8, if then).

## Decision

**Per-environment matrix:**

| Environment | Active ClusterIssuers | Ships in git |
|---|---|---|
| **kind (dev)** | `selfsigned` only | ✅ Active now |
| **EKS staging** (Phase 9) | `selfsigned` + `letsencrypt-staging` | 🔲 letsencrypt-staging as commented template in `platform/cert-manager/clusterissuers.yaml`; uncommented in Phase 9 |
| **EKS prod** (Phase 9+) | `selfsigned` + `letsencrypt-staging` + `letsencrypt-prod` | 🔲 letsencrypt-prod as commented template; activated only per production service |

**Why include `selfsigned` in every environment:** it's useful even in prod for internal Certificates that don't need to leave the cluster (e.g., webhook TLS between platform components). Same issuer, same reconciliation code path, universally applicable.

**Why the LE issuers ship as commented templates now (not activated):** the two LE ClusterIssuers require `hostedZoneID` from Phase 1's DnsStack output (not deployed on kind) and IRSA role ARNs that only exist after Phase 9's EKS deploy. Committing them commented preserves the exact YAML shape — the Phase 9 activation is uncommenting + filling in two placeholders, not rewriting the manifests from scratch.

**Why DNS-01 not HTTP-01:** HTTP-01 requires the service be publicly reachable on port 80. Our `.dev` TLD is HSTS-preloaded — browsers refuse HTTP entirely. DNS-01 sidesteps this by only requiring cert-manager have DNS write access, not public HTTP reachability. Also: only DNS-01 can issue wildcard certs, and we'll want `*.idp.seniormankelz.dev` for at least one service.

## Consequences

- **Positive:** kind loop stays offline-capable and free — SelfSigned uses no network. EKS gets browser-trusted certs through a well-worn pattern (LE + DNS-01 + Route53 + IRSA). Same manifests progress from kind → EKS staging → EKS prod by uncommenting issuers, not rewriting. Rate limits handled by staging-first discipline.
- **Negative:** Browsers warn on kind (accepted — dev friction, not user-facing). Test Certificates issued off `selfsigned` cannot be reused for real HTTPS testing (they're structurally valid but not trusted). LE-prod rate limits will bite if any workflow issues certs churnily — must be enforced by process, not by the tool.
- **Neutral:** cert-manager DNS-01 solver needs IRSA on EKS to write Route53 records; this is a Phase 9 dependency, blocked on IRSA setup for the cert-manager service account (parallel to the pattern from ADR-0009). No cost on kind (no AWS API calls). On EKS the Route53 API calls are effectively free at cert-issuance frequency.

## When to revisit

- **Phase 9 EKS deploy.** Uncomment `letsencrypt-staging` first (LE staging endpoint, DNS-01 solver, IRSA role). Test end-to-end (issue a staging cert, verify Secret contents, delete). Then uncomment `letsencrypt-prod` and issue the first real cert.
- **If we adopt mTLS between platform components (Phase 8).** Consider Vault-issued short-lived certs for that plane. Keeps LE for public-facing certs, adds Vault for the internal mesh. Both coexist under the same cert-manager operator.
- **If LE rate limits become a real constraint.** Look at ZeroSSL, Buypass, or an internal CA for services that need churny cert regeneration.
- **If we want scripted client trust for kind dev.** Swap SelfSigned for an internal CA (Option B) and script `security add-trusted-cert` on developer laptops. Not worth it today; useful the first time someone complains about the cert warning in a live demo.

## Related decisions

- [ADR-0009](0009-github-oidc-federation.md) — GitHub OIDC federation established the IRSA pattern we'll reuse for cert-manager's Route53 access on EKS.
- [ADR-0012](0012-subdomain-delegation-for-idp.md) — `idp.seniormankelz.dev` subdomain delegation is what makes DNS-01 possible against Route53.
- [ADR-0014](0014-argocd-raw-install-vs-helm.md) — the ArgoCD install choice; determines how these ClusterIssuers get applied (via ArgoCD Application, not direct kubectl).
- [ADR-0016](0016-cert-manager-install-via-helm.md) — cert-manager operator install; this ADR is the *what does it do* companion to that *how do we install it*.

## References

- [cert-manager — ClusterIssuer reference](https://cert-manager.io/docs/configuration/)
- [cert-manager — SelfSigned issuer](https://cert-manager.io/docs/configuration/selfsigned/)
- [cert-manager — ACME issuer + DNS-01 solver](https://cert-manager.io/docs/configuration/acme/dns01/)
- [cert-manager — Route53 DNS-01 solver + IRSA](https://cert-manager.io/docs/configuration/acme/dns01/route53/)
- [Let's Encrypt — rate limits](https://letsencrypt.org/docs/rate-limits/)
- [Let's Encrypt — staging environment](https://letsencrypt.org/docs/staging-environment/)

## Interview framing

The one-liner: *"SelfSigned for local dev (no network, no cost, exercises the same wiring as any other issuer); Let's Encrypt via DNS-01 for staging and prod on EKS (staging burns first for rate-limit safety). The ClusterIssuers are all in one git file — active ones plus commented templates for the next environment — so migration from kind to EKS is uncommenting, not rewriting. DNS-01 over HTTP-01 because .dev is HSTS-preloaded, and DNS-01 is also the only path to wildcard certs."*
