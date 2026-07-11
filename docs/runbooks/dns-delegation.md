# Runbook — Delegate the `idp` subdomain to Route53 at Namecheap

Follow this once, after the first `cdk deploy DnsStack`. Also follow again after any redeploy that recreates the hosted zone (new NS records will be assigned).

## Symptom / trigger

Any of:

- Freshly deployed `DnsStack` — need to make `idp.seniormankelz.dev` resolvable.
- `dig NS idp.seniormankelz.dev` returns nothing or the apex's nameservers (means delegation didn't take yet or was undone).
- ExternalDNS logs show `HostedZoneId not found` — usually a stale NS record from a previous zone.

## Impact

Until this runbook completes, no workload on the platform is reachable at a real hostname. `cert-manager` can't validate DNS-01 challenges. Backstage, ArgoCD's public URL, and every service Ingress are `curl`-unreachable.

## Diagnosis — what state are we in?

```bash
# What nameservers does Namecheap currently return for the subdomain?
dig NS idp.seniormankelz.dev +short

# What does Route53 say the zone's nameservers are?
aws cloudformation describe-stacks \
  --stack-name DnsStack \
  --region eu-west-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`NameServers`].OutputValue' \
  --output text
```

If the two sets match — delegation is live. Skip to the "Verify" section below.
If they differ, proceed with remediation.

## Remediation — the actual delegation

### Step 1 — grab the four Route53 nameservers

```bash
aws cloudformation describe-stacks \
  --stack-name DnsStack \
  --region eu-west-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`NameServers`].OutputValue' \
  --output text | tr ',' '\n'
```

You'll get output like:

```text
ns-123.awsdns-15.com
ns-456.awsdns-57.net
ns-789.awsdns-11.org
ns-1024.awsdns-64.co.uk
```

Copy these — you'll paste each into Namecheap in Step 3.

### Step 2 — open Namecheap Advanced DNS for the apex

1. Log into <https://ap.www.namecheap.com/> (account `kaycee90`).
2. **Domain List** → find `seniormankelz.dev` → **Manage**.
3. Top tabs → **Advanced DNS**.
4. Scroll to the **Host Records** table.

### Step 3 — add four NS records for the `idp` label

For each of the 4 nameservers from Step 1:

| Type | Host | Value | TTL |
|---|---|---|---|
| `NS Record` | `idp` | `ns-123.awsdns-15.com` | Automatic |
| `NS Record` | `idp` | `ns-456.awsdns-57.net` | Automatic |
| `NS Record` | `idp` | `ns-789.awsdns-11.org` | Automatic |
| `NS Record` | `idp` | `ns-1024.awsdns-64.co.uk` | Automatic |

**Do NOT** touch any existing records with Host `@` or any other host — those belong to Zoho Mail and the apex. Adding NS records at the `idp` label is a pure add; nothing else changes.

Click the **green checkmark** to save. Namecheap accepts the change immediately.

### Step 4 — wait for DNS propagation

Route53 responds instantly. Namecheap's edge and every downstream resolver in the world need to pick up the new records. Typical time: **5–60 minutes.** Worst-case: **~4 hours** (TTL at intermediate resolvers).

## Verify

```bash
# Should return the 4 AWS nameservers, not Namecheap BasicDNS
dig NS idp.seniormankelz.dev +short

# Should return NOERROR with an NS answer section
dig NS idp.seniormankelz.dev +noall +answer

# Sanity — from a public DNS resolver (Google's), same result
dig @8.8.8.8 NS idp.seniormankelz.dev +short
```

All three should return the four `ns-*.awsdns-*` records within an hour.

## Root cause preservation

If this runbook was triggered because delegation *broke*, capture in an incident log:

- Timestamps of when it worked / when it stopped.
- Diff of `dig NS` outputs before/after.
- Any Namecheap Advanced DNS changes visible in Namecheap's change history.
- Any `cdk deploy` / `cdk destroy` events on `DnsStack` around the failure window.

## Prevention

- **Never `cdk destroy DnsStack` without first deleting the four NS records at Namecheap.** Doing so leaves a *lame delegation* — records pointing at nameservers that no longer exist. Symptom: `SERVFAIL` when resolving anything under the subdomain.
- If you must re-deploy `DnsStack`, expect new nameservers. Repeat this runbook end-to-end.
- Consider adding a Namecheap DNS API integration in a future stack (Phase 10 stretch) so this becomes fully automated.

## References

- [ADR-0012 — Subdomain delegation for idp.seniormankelz.dev](../adr/0012-subdomain-delegation-for-idp.md)
- [`memory/dns-setup`](../../.claude/projects/-Users-kaycee-Project-internal-developer-platform/memory/dns_setup.md) — background context.
- [AWS docs — Testing DNS with dig](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-configuring.html)
