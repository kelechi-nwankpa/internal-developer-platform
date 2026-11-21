#!/usr/bin/env bash
# policy-test.sh — test Kyverno policies offline against example pods.
#
# Layout: platform/kyverno/tests/<policy-name>/{resources.yaml,expected.txt}
# tests platform/kyverno/policies/<policy-name>.yaml. Run: make policy-test
#
# Why not `kyverno test`: checked on CLI v1.14.4 to v1.16.1 (2026-11-21),
# it counts a row as passed even when it prints "Want fail, got pass", and
# when a rule matched nothing at all. A policy edited to allow port 8080,
# or pointed at the wrong namespace, still showed "10 tests passed".
# So this runs `kyverno apply`, takes its report, and compares it line for
# line with expected.txt. Exact match or fail.
#
# The CLI runs from the image matching the in-cluster Kyverno version, so
# nothing needs installing beyond docker + jq.
#
# KYVERNO_DIR can point at a copy of platform/kyverno (used to check that
# a deliberately broken policy makes this script fail).
set -euo pipefail

CLI_IMAGE="ghcr.io/kyverno/kyverno-cli:v1.15.1"
DIR="${KYVERNO_DIR:-platform/kyverno}"

for t in docker jq; do
  command -v "$t" >/dev/null 2>&1 || { echo "required tool not found: $t" >&2; exit 1; }
done

abs=$(cd "$DIR" && pwd)
failed=0
count=0
for testdir in "$DIR"/tests/*/; do
  name=$(basename "$testdir")
  for f in "policies/$name.yaml" "tests/$name/resources.yaml" "tests/$name/expected.txt"; do
    [[ -f "$DIR/$f" ]] || { echo "missing $DIR/$f" >&2; exit 1; }
  done

  # `apply` exits non-zero whenever any resource fails a rule, which is
  # expected here; the report is what gets judged. Lines before the JSON
  # document are progress text.
  report=$(docker run --rm -v "$abs:/k:ro" "$CLI_IMAGE" apply "/k/policies/$name.yaml" \
    --resource "/k/tests/$name/resources.yaml" --policy-report --output-format json 2>/dev/null | sed -n '/^{/,$p' || true)
  [[ -n "$report" ]] || { echo "$name: kyverno apply produced no report" >&2; exit 1; }

  actual=$(jq -r '.results[]? | "\(.rule) \(.resources[0].namespace)/\(.resources[0].name) \(.result)"' <<<"$report" | sort)
  expected=$(grep -vE '^\s*(#|$)' "$DIR/tests/$name/expected.txt" | sort)

  count=$((count + 1))
  if [[ "$actual" == "$expected" ]]; then
    echo "ok    $name ($(wc -l <<<"$expected" | tr -d ' ') results)"
  else
    echo "FAIL  $name   (< expected   > actual)"
    diff <(echo "$expected") <(echo "$actual") || true
    failed=1
  fi
done

[[ $count -gt 0 ]] || { echo "no policy tests found under $DIR/tests" >&2; exit 1; }
exit $failed
