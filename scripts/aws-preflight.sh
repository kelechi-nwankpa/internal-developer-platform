#!/usr/bin/env bash
# aws-preflight.sh — refuse to deploy when it would cost more than intended.
#
# Run by `make aws-up` before anything is deployed (Phase 9). Exists because
# Phase 1 cost $27.17 against a $5-15 projection: the pinned Kubernetes
# version was in EKS *extended* support ($0.50/h surcharge, 43% of the bill)
# and nothing compared spend to the cap before deploying (docs/COST.md).
#
# Fails CLOSED: a check that cannot run counts as a failure.
#
# Checks:
#   1. tools        aws (new enough for describe-cluster-versions), jq, npx
#   2. credentials  aws sts get-caller-identity
#   3. version      the Kubernetes version in the SYNTHESIZED template (what
#                   would really deploy) is in EKS standard support
#   4. budget       lifetime spend + session estimate <= cap
#   5. leftovers    (warning only) clusters already running in the region
#
# Cost of running this: one Cost Explorer request ($0.01).
#
# Configuration comes from the Makefile (so changing the cap is a Git commit):
#   AWS_REGION  BUDGET_CAP_USD  SESSION_ESTIMATE_USD  PROJECT_START  CDK_DIR
#
# The decision functions below are pure (no AWS calls) and are unit-tested by
# scripts/tests/aws-preflight.test.sh, which sources this file.

set -uo pipefail

RED=$'\033[1;31m'; GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RESET=$'\033[0m'
FAILURES=0

pass() { printf '%s  PASS%s  %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s  WARN%s  %s\n' "$YELLOW" "$RESET" "$1"; }
fail() { printf '%s  FAIL%s  %s\n' "$RED" "$RESET" "$1"; FAILURES=$((FAILURES + 1)); }

# ── Pure decision functions (unit-tested) ────────────────────────────────

# days_until <YYYY-MM-DD> <today YYYY-MM-DD> → whole days (may be negative)
days_until() {
  jq -rn --arg d "$1" --arg t "$2" \
    '((($d | strptime("%Y-%m-%d") | mktime) - ($t | strptime("%Y-%m-%d") | mktime)) / 86400) | floor' 2>/dev/null
}

# version_verdict <status> <standard-support-end YYYY-MM-DD> <today>
# Prints "ok", "warn:<days>" (ends within 30 days) or "fail:<reason>".
version_verdict() {
  local status="$1" std_end="$2" today="$3" days
  if [[ "$status" != "STANDARD_SUPPORT" ]]; then
    echo "fail:status is ${status:-unknown}, not STANDARD_SUPPORT"; return
  fi
  days=$(days_until "$std_end" "$today") || { echo "fail:cannot parse end date '$std_end'"; return; }
  if (( days < 0 )); then echo "fail:standard support ended $std_end"; return; fi
  if (( days <= 30 )); then echo "warn:$days"; return; fi
  echo "ok"
}

# budget_verdict <spent> <estimate> <cap>
# Prints "ok:<headroom after session>" or "fail:<amount over>".
budget_verdict() {
  awk -v s="$1" -v e="$2" -v c="$3" 'BEGIN {
    if (s !~ /^[0-9]+(\.[0-9]+)?$/ || e !~ /^[0-9]+(\.[0-9]+)?$/ || c !~ /^[0-9]+(\.[0-9]+)?$/) {
      print "fail:non-numeric input"; exit
    }
    left = c - s - e
    if (left < 0) printf "fail:%.2f\n", -left; else printf "ok:%.2f\n", left
  }'
}

# ── Data gathering (talks to AWS / CDK) ──────────────────────────────────

check_tools() {
  local t missing=0
  for t in aws jq npx; do
    command -v "$t" >/dev/null 2>&1 || { fail "required tool not found: $t"; missing=1; }
  done
  (( missing )) && return 1
  if aws eks describe-cluster-versions help >/dev/null 2>&1; then
    pass "tools present (aws $(aws --version 2>&1 | cut -d' ' -f1 | cut -d/ -f2), jq, npx)"
  else
    fail "AWS CLI too old: 'aws eks describe-cluster-versions' is missing. Update the CLI."
    return 1
  fi
}

check_credentials() {
  local arn
  if arn=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null); then
    pass "AWS credentials valid ($arn)"
  else
    fail "AWS credentials not usable. Run 'aws configure' or 'aws sso login'."
    return 1
  fi
}

# Echoes the Kubernetes version found in the synthesized ClusterStack template.
pinned_version() {
  local tpl="$CDK_DIR/cdk.out/ClusterStack.template.json"
  (cd "$CDK_DIR" && AWS_REGION="$AWS_REGION" npx cdk synth --quiet >/dev/null 2>&1) || return 1
  [[ -f "$tpl" ]] || return 1
  jq -er '[.Resources[] | select(.Type | test("EKS-Cluster|EKS::Cluster"))
            | (.Properties.Config.version // .Properties.Version)] | first' "$tpl"
}

check_version() {
  local ver rec status std_end verdict today
  if ! ver=$(pinned_version) || [[ -z "$ver" || "$ver" == "null" ]]; then
    fail "could not read the Kubernetes version from the synthesized template (cdk synth failed?)"
    return 1
  fi
  if ! rec=$(aws eks describe-cluster-versions --region "$AWS_REGION" --output json 2>/dev/null \
              | jq -ec --arg v "$ver" '.clusterVersions[] | select(.clusterVersion == $v)'); then
    fail "Kubernetes $ver: EKS returned no support record (cannot verify, refusing)"
    return 1
  fi
  status=$(jq -r '.versionStatus // .status // ""' <<<"$rec")
  std_end=$(jq -r '(.endOfStandardSupportDate // "")[0:10]' <<<"$rec")
  today=$(jq -rn 'now | strftime("%Y-%m-%d")')
  verdict=$(version_verdict "$status" "$std_end" "$today")
  case "$verdict" in
    ok)      pass "Kubernetes $ver is in standard support until $std_end" ;;
    warn:*)  warn "Kubernetes $ver leaves standard support in ${verdict#warn:} days ($std_end): plan a bump"
              pass "Kubernetes $ver is in standard support today" ;;
    *)       fail "Kubernetes $ver: ${verdict#fail:}. Extended support adds \$0.50/h. Bump the version in infra/lib/cluster-stack.ts." ;;
  esac
}

check_budget() {
  local end spent verdict
  end=$(jq -rn 'now + 86400 | strftime("%Y-%m-%d")')
  if ! spent=$(aws ce get-cost-and-usage --region us-east-1 \
                  --time-period "Start=$PROJECT_START,End=$end" \
                  --granularity MONTHLY --metrics UnblendedCost --output json 2>/dev/null \
                | jq -er '[.ResultsByTime[].Total.UnblendedCost.Amount | tonumber] | add | . * 100 | round / 100'); then
    fail "could not read lifetime spend from Cost Explorer (cannot verify, refusing)"
    return 1
  fi
  verdict=$(budget_verdict "$spent" "$SESSION_ESTIMATE_USD" "$BUDGET_CAP_USD")
  case "$verdict" in
    ok:*) pass "budget: \$$spent spent + \$$SESSION_ESTIMATE_USD session estimate <= \$$BUDGET_CAP_USD cap (\$${verdict#ok:} left after)" ;;
    *)    fail "budget: \$$spent spent + \$$SESSION_ESTIMATE_USD session estimate exceeds the \$$BUDGET_CAP_USD cap by \$${verdict#fail:}. Raising the cap is the owner's decision: change BUDGET_CAP_USD in the Makefile and docs/COST.md in one commit." ;;
  esac
}

check_leftovers() {
  local clusters
  clusters=$(aws eks list-clusters --region "$AWS_REGION" --query 'clusters' --output text 2>/dev/null) || {
    warn "could not list EKS clusters"; return 0; }
  if [[ -n "$clusters" && "$clusters" != "None" ]]; then
    warn "EKS cluster(s) already exist in $AWS_REGION and are billing now: $clusters"
  else
    pass "no EKS clusters currently running in $AWS_REGION"
  fi
}

main() {
  : "${AWS_REGION:?set AWS_REGION}" "${BUDGET_CAP_USD:?set BUDGET_CAP_USD}"
  : "${SESSION_ESTIMATE_USD:?set SESSION_ESTIMATE_USD}" "${PROJECT_START:?set PROJECT_START}"
  : "${CDK_DIR:?set CDK_DIR}"

  printf 'AWS preflight (region %s, cap $%s, session estimate $%s)\n' \
    "$AWS_REGION" "$BUDGET_CAP_USD" "$SESSION_ESTIMATE_USD"

  if check_tools && check_credentials; then
    check_version
    check_budget
    check_leftovers
  fi

  if (( FAILURES > 0 )); then
    printf '%sPreflight FAILED (%d check(s)). Nothing was deployed.%s\n' "$RED" "$FAILURES" "$RESET"
    exit 1
  fi
  printf '%sPreflight passed.%s\n' "$GREEN" "$RESET"
}

# Run only when executed, not when sourced by the tests.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
