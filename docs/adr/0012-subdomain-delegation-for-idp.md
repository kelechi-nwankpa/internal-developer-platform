# 0012 — Subdomain delegation for `idp.seniormankelz.dev`

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

The platform needs a public DNS zone that ExternalDNS (Phase 2) can add records to for every workload with an Ingress. Real TLS (via cert-manager + Let's Encrypt) requires the zone to be resolvable from the internet.

The registrant already owns `seniormankelz.dev` at Namecheap. The apex domain is in active use:

- **Namecheap BasicDNS** hosts the authoritative records.
- **Zoho Mail** owns the MX / SPF / DKIM / DMARC records on the apex — a live email account depends on them.
- Namecheap features (WHOIS privacy, auto-renew, email forwarding) are configured on the apex.

We need DNS for the platform *without* disturbing any of the above.

## Decision drivers

- Do not break Zoho email (biggest risk).
- Preserve apex flexibility for a future portfolio site at `seniormankelz.dev`.
- Fully reversible with no downtime.
- Auditable in Namecheap's UI.
- Zero moving pieces at the registrar-transfer level.

## Options considered

### Option A — Full nameserver switch (Namecheap → Route53)

Change the domain's nameservers at Namecheap to Route53's 4 assigned nameservers. Route53 becomes authoritative for the entire domain.

- Pros: Simplest CDK code — one HostedZone for the apex, no NS record dance.
- Cons: **Immediately breaks Zoho email** the moment nameservers switch. Every MX / SPF / DKIM / DMARC record has to be recreated in Route53 before the switch, tested, verified. Any typo silently kills email delivery. Not reversible without another nameserver flip. Nightmare rollback story.

### Option B — Subdomain delegation via NS records at Namecheap (chosen)

Keep Namecheap authoritative for the apex. Create a Route53 hosted zone for `idp.seniormankelz.dev` only. Namecheap gets 4 `NS` records for the `idp` label pointing at Route53's nameservers.

- Pros: **Apex email untouched.** Portfolio site can go anywhere later. Reversible by deleting the 4 NS records — Namecheap becomes authoritative again in one propagation cycle. Fine-grained blast radius.
- Cons: 4 NS records to manually copy into Namecheap once. Documented as a runbook (see docs/runbooks/dns-delegation.md).

### Option C — Skip DNS, use nip.io or sslip.io

Wildcard DNS services that resolve `<IP>.nip.io` to the IP.

- Pros: Zero setup. Free.
- Cons: No TLS story (Let's Encrypt rate-limits `nip.io` hard). Can't demo a real domain. Undermines the "production-shaped" pitch.

### Option D — Use a different registrar / new domain

Buy a fresh domain (e.g. `idp-portfolio.dev`) whose nameservers can safely switch to Route53.

- Pros: Full nameserver control from day one.
- Cons: $12–15 for a domain we don't need. Doesn't demonstrate the delegation pattern that a real production migration would use.

## Decision

**Option B — subdomain delegation.** Zoho email on the apex is the load-bearing constraint. Subdomain delegation is a mechanically clean answer that both protects email and produces the correct portfolio artefact.

Implementation:

- **DnsStack** creates a Route53 hosted zone for `idp.seniormankelz.dev`.
- **CDK deploy output** lists the 4 assigned nameservers.
- **Manual step** (documented in `docs/runbooks/dns-delegation.md`): human copies the 4 nameservers into Namecheap Advanced DNS as `NS` records at the `idp` label.
- **Propagation** — usually under an hour, worst-case a few hours for TTLs to expire globally.
- **Verify** — `dig NS idp.seniormankelz.dev` returns the four AWS nameservers.

## Consequences

- **Positive:** Zoho email untouched. Fully reversible (delete NS records → Namecheap re-authoritative). Real, browser-usable HTTPS URL for the platform demo (`.dev` is HSTS-preloaded, so every subdomain must serve TLS — that's a feature, not a bug). ExternalDNS + cert-manager can operate on the zone with a scoped IAM policy.
- **Negative:** Requires a one-time manual step at Namecheap. Not fully IaC. Documented as a runbook + captured in the phase log.
- **Neutral:** Cross-service dependency between AWS CDK and Namecheap DNS. Namecheap's UI could redesign; runbook screenshots may age.

## When to revisit

- If we ever move `seniormankelz.dev` off Zoho and off Namecheap — then Option A (full nameserver switch) becomes clean and this ADR should be superseded.
- If the manual NS-record step becomes annoying (unlikely at portfolio scale), consider Namecheap's DNS API + an out-of-band script.
- If we adopt AWS Organizations and want the DNS zone in a separate account, we'd add cross-account trust to the ExternalDNS IAM policy — the zone stays exactly as designed.

## Related decisions

- [ADR-0007](0007-vpc-endpoints-instead-of-nat-gateway.md) — the Route53 API doesn't have a VPC endpoint; ExternalDNS pod's calls to Route53 will use the STS interface endpoint and IRSA for auth, not a direct Route53 endpoint. Fine — Route53 is a global (not region-scoped) service and always accessed via public API.

## References

- [AWS docs — Subdomain delegation with Route53](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/CreatingNewSubdomain.html)
- [Namecheap — Managing NS records via Advanced DNS](https://www.namecheap.com/support/knowledgebase/article.aspx/9776/2237/how-to-manage-nameservers-for-your-domain/)
- [`.dev` HSTS preload](https://hstspreload.org/?domain=dev)
- Project memory: `dns-setup` — the pre-decision context.
