# 0038 — cert-manager's IAM role may write certificate challenge records only

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

On EKS the edge certificate (`*.idp.seniormankelz.dev`) comes from Let's
Encrypt. Let's Encrypt issues a wildcard certificate only after a DNS-01
challenge: cert-manager writes a TXT record named
`_acme-challenge.idp.seniormankelz.dev` into our Route53 zone, and Let's
Encrypt looks it up. So cert-manager needs an IAM role that can write to
the zone.

Writing to a DNS zone is a strong permission. Whoever can change any
record can point `backstage.idp.seniormankelz.dev` at their own server,
get a real certificate for it, and read what users send.

## Decision drivers

- A stolen cert-manager token must not be able to redirect a hostname.
- The role must not reach other projects' zones in this shared account.
- No per-session value in Git ([ADR-0037](0037-session-identities-enter-at-bootstrap.md)).

## Options considered

### Option A — cert-manager's documented policy

`ChangeResourceRecordSets` and `ListResourceRecordSets` on
`hostedzone/*`, `GetChange` on `change/*`, `ListHostedZonesByName` on `*`.

- Pros: Copy and paste. Known to work.
- Cons: Any record, any type, in every zone of the account, including
  other projects'.

### Option B — The documented policy, limited to our zone

- Pros: Other projects are safe.
- Cons: Inside our zone the role can still change any record. The
  hostname takeover above stays possible.

### Option C — Our zone, TXT only, challenge names only (chosen)

Route53 has IAM condition keys for the record type and the record name
of a change. The write is allowed only when every changed record is a
TXT record named `_acme-challenge.<zone>` or
`_acme-challenge.<anything>.<zone>`.

- Pros: The role can do its one job and nothing else in DNS.
- Cons: Two more conditions to get right. A typo means "access denied"
  in a billed session.

### Option D — HTTP-01 challenge, no DNS permission at all

- Cons: Let's Encrypt does not issue wildcard certificates over
  HTTP-01. We would need one certificate per service
  ([ADR-0033](0033-edge-routing-via-gateway-api.md) explains why one
  wildcard).

### Option E — A separate zone only for challenges (CNAME delegation)

`_acme-challenge` becomes a CNAME into a second zone, and the role may
write only there.

- Pros: The strongest separation; the common answer when the IAM
  conditions of option C are not available (other DNS providers).
- Cons: A second zone ($0.50 a month) and one more moving part, for
  what option C already gives on Route53.

## Decision

**Option C.** The role is `CertManagerRole` in
[`infra/lib/cert-manager-role.ts`](../../infra/lib/cert-manager-role.ts).

| Statement | Action | Resource | Extra limit |
|---|---|---|---|
| `WriteAcmeChallengeRecords` | `ChangeResourceRecordSets` | our zone's ARN | TXT only; challenge names only |
| `ListRecordsInProjectZone` | `ListResourceRecordSets` | our zone's ARN | — |
| `FindZoneByName` | `ListHostedZonesByName` | `*` | read-only |
| `ReadChangeStatus` | `GetChange` | `change/*` | read-only |

- **Why `ListHostedZonesByName`:** cert-manager then finds the zone by
  its name. The alternative is writing the zone id into the issuer, and
  the zone id changes whenever the zone is recreated. AWS accepts no
  resource for this call, so `*` is the only form. It returns zone names
  and ids, also other projects'. That is the price.
- **Why `change/*`:** Route53 makes up a change id per change. The call
  returns only "pending" or "done".
- **Why `ForAllValues`:** one request can change several records. All
  of them must match, not just one.
- **Why the second name pattern:** a later certificate for
  `*.team.idp.seniormankelz.dev` uses `_acme-challenge.team.…`. The
  pattern still starts with `_acme-challenge.`, so it cannot match an
  ordinary hostname.

Which resources and condition keys each action accepts was read from
the AWS service authorization reference, not from memory.

Trust is IRSA for exactly
`system:serviceaccount:cert-manager:cert-manager`. cert-manager's
webhook and cainjector run under other ServiceAccounts and get nothing.

### Stack order

The role lives in `ClusterStack` (its trust names the cluster) and names
the zone from `DnsStack`. So `ClusterStack` now depends on `DnsStack`:

- deploy: zone first, cluster second;
- teardown timer: `DnsStack` moved to the second group, deleted after
  the cluster is gone. **The timer's stack list is part of `CostStack`,
  so `CostStack` must be redeployed once before the session.**

### cdk-nag

Two `AwsSolutions-IAM5` findings, both on read-only statements:
`Resource::*` (`FindZoneByName`) and
`Resource::arn:aws:route53:::change/*` (`ReadChangeStatus`). Each gets
its own exception on this role, limited with `appliesTo` to that exact
string ([ADR-0013](0013-cdk-nag-suppression-policy.md)). Approved by the
owner on 2026-11-27.

Proven by breaking it: `hostedzone/*` on this role fails `cdk synth`.

## Consequences

- **Positive:** A stolen token cannot change where any hostname points,
  in our zone or any other. The unit tests pin the whole policy.
- **Negative:** The token can still get a certificate issued for any
  name in our zone. That is what the challenge record is for and cannot
  be narrowed further in IAM. Certificate Transparency logs would show
  such a certificate.
- **Negative:** A missing permission shows only in a live session, as a
  failed Challenge in cert-manager with `AccessDenied`.
- **Not proven until the session:** that Route53 evaluates the two
  conditions the way the reference describes for cert-manager's real
  requests (it sends upper-case `UPSERT`/`DELETE` of one TXT record).

## When to revisit

- **The conditions block a real request.** Fall back to option B for
  the session and record why here.
- **We move DNS off Route53.** Option E.
- **external-dns gets its role (gap 5).** It needs A and CNAME records,
  so it gets its own role; the two must never be merged.

## Related decisions

- [ADR-0012](0012-subdomain-delegation-for-idp.md) — the zone.
- [ADR-0017](0017-cert-manager-issuer-strategy.md) — issuers.
- [ADR-0033](0033-edge-routing-via-gateway-api.md) — the wildcard certificate.
- [ADR-0036](0036-trimmed-iam-policy-for-load-balancer-controller.md) — the first IRSA role.
- [ADR-0037](0037-session-identities-enter-at-bootstrap.md) — how the role ARN reaches the cluster.

## References

- [cert-manager — Route53 DNS-01](https://cert-manager.io/docs/configuration/acme/dns01/route53/)
- [Route53 — fine-grained permissions for record sets](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/specifying-rrset-conditions.html)
- [Actions, resources and condition keys for Route53](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonroute53.html)
