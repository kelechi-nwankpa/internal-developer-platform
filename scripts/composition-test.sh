#!/usr/bin/env bash
# composition-test.sh — test Crossplane Compositions offline. No cluster,
# no AWS, $0. Run: make composition-test
#
# WHY: the S3 Composition only runs for real on EKS, which costs money and
# is rarely up. Without this, a wrong field name or a too-wide IAM policy
# would first show up during a paid session. This renders the Composition
# on the laptop and checks the result three ways:
#   1. exact match   the rendered output equals expected.yaml, line for
#                    line (or, for a case that must be refused, the error
#                    contains expected-error.txt)
#   2. schema        every rendered AWS resource is valid against the
#                    provider's real schema (versions from providers.yaml)
#   3. IAM rules     every IAM document is valid JSON, grants only S3
#                    actions on one named bucket, and the role trusts
#                    exactly one ServiceAccount (composition-iam-rules.rb)
# Check 3 repeats part of check 1 on purpose: expected.yaml can be
# regenerated without reading it, these rules cannot.
#
# Layout: platform/crossplane/tests/<suite>/
#   composition          one line: the Composition file under test
#   cases/<case>/xr.yaml           the bucket request (required)
#   cases/<case>/required.yaml     cluster objects the Composition asks for
#   cases/<case>/observed.yaml     pretend "already created" resources
#   cases/<case>/expected.yaml     OR  expected-error.txt
#
# UPDATE=1 rewrites expected.yaml from the current output. Read the diff
# before committing it.
# CROSSPLANE_DIR can point at a copy of platform/crossplane (used to check
# that a deliberately broken Composition makes this script fail).
#
# LIMITS (stated so nobody over-trusts a green run):
#   - The render engine is Crossplane v2 (the CLI cannot run v1 engines);
#     the cluster runs v1.20. The functions are the same images at the
#     same versions, and they produce the resources.
#   - `render` does not print connection details. The Secret's condition
#     is asserted through status.roleArn, set under the same `if`. The
#     Secret's key names are checked by reading, not by this script.
#   - Nothing here proves AWS accepts the result. That is the EKS session.
set -euo pipefail

# The engine version is pinned: the default is a floating "stable" tag.
ENGINE_VERSION="v2.4.1"
DIR="${CROSSPLANE_DIR:-platform/crossplane}"
CACHE="${CROSSPLANE_SCHEMA_CACHE:-$HOME/.crossplane/cache}"

for t in docker crossplane ruby diff; do
  command -v "$t" >/dev/null 2>&1 || { echo "required tool not found: $t" >&2; exit 1; }
done
# Docker Desktop's socket is not at the default path the CLI library uses.
if [[ -z "${DOCKER_HOST:-}" ]]; then
  DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
  export DOCKER_HOST
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/composition-test.XXXXXX")
trap 'rm -rf "${work:?}"' EXIT

failed=0
count=0
for suite in "$DIR"/tests/*/; do
  sname=$(basename "$suite")
  [[ -f "$suite/composition" ]] || { echo "missing $suite/composition" >&2; exit 1; }
  comp="$DIR/$(tr -d '[:space:]' <"$suite/composition")"
  [[ -f "$comp" ]] || { echo "$sname: Composition not found: $comp" >&2; exit 1; }

  for case in "$suite"cases/*/; do
    cname="$sname/$(basename "$case")"
    count=$((count + 1))
    [[ -f "$case/xr.yaml" ]] || { echo "missing ${case}xr.yaml" >&2; exit 1; }
    args=("$case/xr.yaml" "$comp" "$DIR/functions.yaml" "--crossplane-version=$ENGINE_VERSION")
    [[ -f "$case/required.yaml" ]] && args+=("--required-resources=$case/required.yaml")
    [[ -f "$case/observed.yaml" ]] && args+=("--observed-resources=$case/observed.yaml")

    rc=0
    crossplane render "${args[@]}" >"$work/out.yaml" 2>"$work/err.txt" || rc=$?

    # --- a case that must be refused ---
    if [[ -f "$case/expected-error.txt" ]]; then
      want=$(grep -vE '^\s*(#|$)' "$case/expected-error.txt")
      if [[ $rc -ne 0 ]] && grep -qF -- "$want" "$work/err.txt"; then
        echo "ok    $cname (refused as expected)"
      else
        echo "FAIL  $cname: expected a refusal containing: $want"
        if [[ $rc -eq 0 ]]; then echo "      but it rendered successfully"; else tail -c 400 "$work/err.txt"; fi
        failed=1
      fi
      continue
    fi

    if [[ $rc -ne 0 ]]; then
      echo "FAIL  $cname: render failed"; tail -c 600 "$work/err.txt"; failed=1; continue
    fi

    # --- check 1: exact match ---
    if [[ "${UPDATE:-}" == "1" ]]; then
      cp "$work/out.yaml" "$case/expected.yaml"
      echo "wrote ${case}expected.yaml"
    fi
    [[ -f "$case/expected.yaml" ]] || { echo "missing ${case}expected.yaml (or expected-error.txt)" >&2; exit 1; }
    problems=""
    if ! diff "$case/expected.yaml" "$work/out.yaml" >"$work/diff.txt"; then
      problems+="output differs from expected.yaml   (< expected   > actual)"$'\n'"$(cat "$work/diff.txt")"$'\n'
    fi

    # --- check 2: schemas. The bucket request itself is skipped: the v2
    # engine writes it in v2 shape, which the v1 definition rejects.
    summary=$(crossplane resource validate "$DIR/providers.yaml" "$work/out.yaml" --cache-dir "$CACHE" 2>&1 || true)
    total=$(grep -E '^Total [0-9]+ resources' <<<"$summary" || true)
    if [[ ! "$total" =~ ^Total\ ([0-9]+)\ resources:\ 1\ missing\ schemas,\ ([0-9]+)\ success\ cases,\ 0\ failure\ cases$ ]] ||
      [[ $((BASH_REMATCH[1] - 1)) -ne ${BASH_REMATCH[2]} ]]; then
      problems+="schema check: $(grep -vE '^\[✓\]' <<<"$summary")"$'\n'
    fi

    # --- check 3: IAM rules ---
    # (ruby's stderr is dropped: this Mac prints gem warnings there.)
    iam_rc=0
    iam=$("$(dirname "$0")/composition-iam-rules.rb" "$work/out.yaml" 2>/dev/null) || iam_rc=$?
    [[ $iam_rc -eq 0 || -n "$iam" ]] || iam="IAM rule check could not run (exit $iam_rc)"
    [[ -z "$iam" ]] || problems+="$iam"$'\n'
    if grep -q '^kind: Bucket$' "$work/out.yaml" && ! grep -q '^kind: Role$' "$work/out.yaml"; then
      problems+="a bucket was rendered without an IAM role"$'\n'
    fi

    if [[ -z "$problems" ]]; then
      echo "ok    $cname ($(grep -c '^kind: ' "$work/out.yaml") objects, schemas valid)"
    else
      echo "FAIL  $cname"; printf '%s' "$problems" | sed 's/^/      /'; failed=1
    fi
  done
done

[[ $count -gt 0 ]] || { echo "no composition tests found under $DIR/tests" >&2; exit 1; }
exit $failed
