#!/usr/bin/env bash
# Unit tests for the pure decision functions in scripts/aws-preflight.sh.
# No AWS calls. Run: make preflight-test   (or: bash scripts/tests/aws-preflight.test.sh)
#
# Each rule is tested in both directions so the tests can actually fail.

set -uo pipefail
# shellcheck source=scripts/aws-preflight.sh
source "$(dirname "${BASH_SOURCE[0]}")/../aws-preflight.sh"

PASSED=0; FAILED=0
expect() { # expect <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$1"
  else FAILED=$((FAILED + 1)); printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi
}

echo "days_until"
expect "30 days ahead"          "30"  "$(days_until 2026-12-21 2026-11-21)"
expect "same day"               "0"   "$(days_until 2026-11-21 2026-11-21)"
expect "in the past"            "-360" "$(days_until 2025-11-26 2026-11-21)"

echo "version_verdict"
expect "standard support, far end date → ok" \
  "ok" "$(version_verdict STANDARD_SUPPORT 2027-08-02 2026-11-21)"
expect "Phase 1 case: 1.31 in extended support → fail" \
  "fail:status is EXTENDED_SUPPORT, not STANDARD_SUPPORT" \
  "$(version_verdict EXTENDED_SUPPORT 2025-11-26 2026-07-10)"
expect "standard support ending in 11 days → warn" \
  "warn:11" "$(version_verdict STANDARD_SUPPORT 2026-12-02 2026-11-21)"
expect "exactly 30 days left → warn" \
  "warn:30" "$(version_verdict STANDARD_SUPPORT 2026-12-21 2026-11-21)"
expect "31 days left → ok" \
  "ok" "$(version_verdict STANDARD_SUPPORT 2026-12-22 2026-11-21)"
expect "status says standard but end date already passed → fail" \
  "fail:standard support ended 2026-11-01" \
  "$(version_verdict STANDARD_SUPPORT 2026-11-01 2026-11-21)"
expect "empty status (API gave nothing) → fail" \
  "fail:status is unknown, not STANDARD_SUPPORT" "$(version_verdict "" 2027-08-02 2026-11-21)"
expect "unparseable end date → fail" \
  "fail:cannot parse end date 'garbage'" "$(version_verdict STANDARD_SUPPORT garbage 2026-11-21)"

echo "budget_verdict"
expect "today: 27.19 spent + 4 estimate vs 30 cap → fail by 1.19" \
  "fail:1.19" "$(budget_verdict 27.19 4 30)"
expect "same spend with the cap raised to 40 → ok, 8.81 left" \
  "ok:8.81" "$(budget_verdict 27.19 4 40)"
expect "exactly at the cap → ok, 0.00 left" \
  "ok:0.00" "$(budget_verdict 26 4 30)"
expect "one cent over → fail" \
  "fail:0.01" "$(budget_verdict 26.01 4 30)"
expect "empty spend (Cost Explorer gave nothing) → fail" \
  "fail:non-numeric input" "$(budget_verdict "" 4 30)"
expect "non-numeric cap → fail" \
  "fail:non-numeric input" "$(budget_verdict 27.19 4 thirty)"

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
