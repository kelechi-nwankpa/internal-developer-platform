#!/usr/bin/env bash
# rules-test.sh — unit-test every PrometheusRule with promtool.
#
# Why a script: PrometheusRule is a Kubernetes wrapper; promtool wants the
# bare {groups: ...} document. This extracts it for each rule file and runs
# the matching test file. promtool runs from the pinned Prometheus image,
# so nothing needs installing beyond docker + kubectl + jq.
#
# Add a pair below when adding a rule file. Run: make rules-test
set -euo pipefail

PROM_IMAGE="prom/prometheus:v3.5.0"
DIR="platform/monitoring"
T="$DIR/tests"

# "<rule manifest>|<generated file the test's rule_files points at>|<test>"
PAIRS=(
  "argocd-app-health-rules.yaml|rules.json|argocd-app-health.test.yaml"
  "platform-health-rules.yaml|platform-health.rules.json|platform-health.test.yaml"
)

for t in docker kubectl jq; do
  command -v "$t" >/dev/null 2>&1 || { echo "required tool not found: $t" >&2; exit 1; }
done

tests=()
for pair in "${PAIRS[@]}"; do
  IFS='|' read -r manifest generated testfile <<<"$pair"
  [[ -f "$DIR/$manifest" && -f "$T/$testfile" ]] || { echo "missing $manifest or $testfile" >&2; exit 1; }
  kubectl create --dry-run=client -o json -f "$DIR/$manifest" | jq '{groups: .spec.groups}' >"$T/$generated"
  tests+=("$testfile")
done

# Every *.test.yaml must be registered above, or it silently never runs.
for f in "$T"/*.test.yaml; do
  name=$(basename "$f")
  [[ " ${tests[*]} " == *" $name "* ]] || { echo "test file not registered in PAIRS: $name" >&2; exit 1; }
done

docker run --rm -v "$PWD/$T:/t" -w /t --entrypoint promtool "$PROM_IMAGE" test rules "${tests[@]}"
