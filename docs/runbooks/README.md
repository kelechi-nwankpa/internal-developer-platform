# Runbooks

**A runbook is the answer to "what do I do when X breaks at 3am?"** — a scripted, step-by-step procedure that anyone on call can follow without needing to derive the fix from first principles.

Every non-trivial failure mode this platform can experience should have a runbook. If a component doesn't have a runbook, on-call engineering is being asked to do research under pressure — which is the definition of an outage getting worse.

## Structure of a good runbook

Every runbook in this directory follows the same shape:

1. **Symptom** — how does the operator notice this? (alert name, dashboard signal, user report)
2. **Impact** — who's affected, how badly, how quickly.
3. **Diagnosis** — the commands / queries that confirm the failure mode.
4. **Remediation** — the ordered steps to resolve, from safest to most invasive.
5. **Root cause investigation** — what to preserve for the postmortem (logs, traces, cluster snapshots).
6. **Prevention** — link to any ADR or code change that would prevent recurrence.

## Contents (grows per phase)

| Runbook | Introduced in | Trigger |
|---|---|---|
| [dns-delegation.md](dns-delegation.md) | Phase 1 (Task 1.8) | After every `cdk deploy DnsStack` — copy Route53 nameservers into Namecheap |

## References

- [Google SRE Book — Being On-Call](https://sre.google/sre-book/being-on-call/)
- [PagerDuty — Runbook template](https://response.pagerduty.com/before/writing_runbooks/)
