# Runbook — after restoring a deleted GitHub repository

GitHub can restore a deleted repository for 90 days, but the restore is
not complete: several security and automation features come back turned
off, without any notice. This repository was restored once (Phase 8
Wave 1); Dependabot and secret scanning stayed off, unnoticed, until
Phase 8 Wave 3.

## Symptom / trigger

Run this immediately after any repository restore (Settings →
Repositories → Deleted repositories → Restore). There is no alert; the
symptom is silence: no Dependabot pull requests, no secret-scanning
alerts, CI not starting.

## Impact

- Vulnerable dependencies are no longer reported or patched.
- A pushed secret is no longer blocked or flagged.
- CI does not run, so nothing is built, scanned or signed.

None of this breaks the running cluster, which is why it goes unnoticed.

## Diagnosis

Set the repository once, then run the checks. Each line says what a
healthy answer looks like.

```bash
R=<owner>/<repo>

# GitHub Actions enabled?                       healthy: true
gh api repos/$R/actions/permissions --jq '.enabled'

# Dependabot alerts enabled?                    healthy: HTTP 204 (404 = off)
gh api -i repos/$R/vulnerability-alerts | head -1

# Dependabot security updates enabled?          healthy: "enabled":true
gh api repos/$R/automated-security-fixes

# Secret scanning + push protection?            healthy: both "enabled"
gh api repos/$R --jq '.security_and_analysis | {secret_scanning, secret_scanning_push_protection}'

# Branch protection still on main?              healthy: a rule set is listed
gh api repos/$R/rulesets --jq '.[].name'
```

Repeat for every restored repository (this platform has two:
`internal-developer-platform` and `platform-hello`).

## Remediation

Turn on whatever the diagnosis showed as off.

```bash
# Actions: also click "Enable Actions on this repository" if the Actions
# tab shows that banner.
gh api -X PUT repos/$R/actions/permissions -F enabled=true -f allowed_actions=all

# Dependabot alerts, then security updates
gh api -X PUT repos/$R/vulnerability-alerts
gh api -X PUT repos/$R/automated-security-fixes

# Secret scanning and push protection
gh api -X PATCH repos/$R --input - <<'JSON'
{"security_and_analysis": {
  "secret_scanning": {"status": "enabled"},
  "secret_scanning_push_protection": {"status": "enabled"}}}
JSON
```

Then:

1. **Start CI by hand once.** Workflows with `workflow_dispatch` can be started from the Actions tab or with `gh workflow run <file>`.
2. **Expect the first runs to be slow.** The Actions cache is empty after a restore; the Backstage image build took 25–30 minutes instead of 5–8.
3. **Expect a backlog of Dependabot pull requests** within a day. Triage them in groups (see the Phase 8 Wave 3 aftercare notes).
4. **Re-check webhooks, deploy keys and GitHub App installations** (Settings → Webhooks / Deploy keys / GitHub Apps). The Backstage GitHub App must still be installed on the repository for the Scaffolder to work.

Re-run the diagnosis block and confirm every line is healthy.

## Root cause investigation

Note the date of deletion and restore in the phase log. Anything pushed
between the restore and the re-enabling of secret scanning was not
scanned: run `gitleaks detect` over that range.

## Prevention

- Do not delete repositories to "start clean"; archive or rename instead.
- This runbook is the control: GitHub offers no setting that makes a
  restore complete.
