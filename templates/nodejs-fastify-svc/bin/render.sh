#!/usr/bin/env bash
# editorconfig-checker-disable-file
# ^ shell alignment padding + heredoc content indentation are stylistic
#   choices that don't fit editorconfig's multiple-of-2 rule.
# ─────────────────────────────────────────────────────────────────────
# render.sh — sed-based template renderer for nodejs-fastify-svc
#
# Interim tool for Wave 1 (pre-Backstage-Scaffolder). When Wave 2 of
# Phase 5 ships Scaffolder, this script becomes redundant — the same
# skeleton/ directory is consumed by Scaffolder's fetch:template action.
#
# Usage:
#   ./bin/render.sh \
#     --name payments-svc \
#     --owner platform-team \
#     --description "Handles payment processing" \
#     --image-tag v0.1.0 \
#     --repo-url https://github.com/kelechi-nwankpa/payments-svc.git \
#     --output ../../scaffolded/payments-svc
#
# Behavior:
#   - Validates all placeholders are provided + syntactically valid
#     (service name: DNS-1035; image tag: semver; repo URL: https git)
#   - Refuses to run if the output directory already exists (no overwrite)
#   - Copies skeleton/ → output dir, sed-substitutes {{PLACEHOLDER}} tokens
#   - Prints next steps (git init, remote add, first push, add ArgoCD app)
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

# ---- defaults ----
NAME=""
OWNER=""
DESCRIPTION=""
IMAGE_TAG="v0.1.0"
REPO_URL=""
OUTPUT_DIR=""

# ---- argparse ----
usage() {
  cat <<'USAGE'
Usage: render.sh --name <svc> --owner <team> --description <desc> \
                 --image-tag <tag> --repo-url <url> --output <dir>

Required:
  --name          Service name (DNS-1035: kebab-case, start with a letter)
  --owner         Backstage Group entity (kebab-case)
  --description   One-line summary (max 120 chars)
  --repo-url      Git repo URL (https://github.com/OWNER/NAME.git)
  --output        Directory to render into (must NOT exist)

Optional:
  --image-tag     Initial container image tag (default: v0.1.0)
  -h, --help      Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)          NAME="$2";        shift 2 ;;
    --owner)         OWNER="$2";       shift 2 ;;
    --description)   DESCRIPTION="$2"; shift 2 ;;
    --image-tag)     IMAGE_TAG="$2";   shift 2 ;;
    --repo-url)      REPO_URL="$2";    shift 2 ;;
    --output)        OUTPUT_DIR="$2";  shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; usage; exit 2 ;;
  esac
done

# ---- validation ----
die() { echo "ERROR: $1" >&2; exit 1; }

[[ -z "$NAME" ]]        && die "--name is required"
[[ -z "$OWNER" ]]       && die "--owner is required"
[[ -z "$DESCRIPTION" ]] && die "--description is required"
[[ -z "$REPO_URL" ]]    && die "--repo-url is required"
[[ -z "$OUTPUT_DIR" ]]  && die "--output is required"

# Service name: DNS-1035 (RFC 1035) — kebab-case, 2-40 chars, letters +
# digits + hyphens only, must start with a letter, must end alphanumeric.
if ! [[ "$NAME" =~ ^[a-z][a-z0-9-]{1,38}[a-z0-9]$ ]]; then
  die "--name '$NAME' is not DNS-1035 compliant (^[a-z][a-z0-9-]{1,38}[a-z0-9]$)"
fi

# Owner: kebab-case, start with a letter.
if ! [[ "$OWNER" =~ ^[a-z][a-z0-9-]*$ ]]; then
  die "--owner '$OWNER' must be kebab-case (^[a-z][a-z0-9-]*$)"
fi

# Description: max 120 chars.
if [[ ${#DESCRIPTION} -gt 120 ]]; then
  die "--description exceeds 120 chars (was ${#DESCRIPTION})"
fi

# Image tag: semver.
if ! [[ "$IMAGE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$ ]]; then
  die "--image-tag '$IMAGE_TAG' is not semver (^v[0-9]+\.[0-9]+\.[0-9]+(-.*)?$)"
fi

# Repo URL: https GitHub .git URL.
if ! [[ "$REPO_URL" =~ ^https://github\.com/.+/.+\.git$ ]]; then
  die "--repo-url must be https://github.com/OWNER/NAME.git format"
fi

# GitHub org — derived from --repo-url. Distinct from --owner (Backstage
# team). URL fields (catalog-info links, Dockerfile OCI labels, GitHub
# plugin project-slug) use this; team-owned fields (spec.owner, Vault
# path convention) use --owner.
GITHUB_ORG=$(echo "$REPO_URL" | sed -E 's|https://github\.com/([^/]+)/.*|\1|')
if [[ -z "$GITHUB_ORG" ]]; then
  die "failed to derive GITHUB_ORG from --repo-url '$REPO_URL'"
fi

# Output dir: must not exist (refuse to overwrite).
if [[ -e "$OUTPUT_DIR" ]]; then
  die "--output '$OUTPUT_DIR' already exists; refusing to overwrite"
fi

# ---- render ----
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SKELETON_DIR="$( cd "$SCRIPT_DIR/../skeleton" && pwd )"

if [[ ! -d "$SKELETON_DIR" ]]; then
  die "skeleton/ not found at $SKELETON_DIR (script must be run from templates/nodejs-fastify-svc/bin/)"
fi

echo "→ Rendering $SKELETON_DIR → $OUTPUT_DIR"
mkdir -p "$(dirname "$OUTPUT_DIR")"
cp -R "$SKELETON_DIR" "$OUTPUT_DIR"

# sed portability: BSD sed (macOS) requires `-i ''`; GNU sed just `-i`.
# Detect once and use consistently.
if sed --version >/dev/null 2>&1; then
  SED_INPLACE=(-i)   # GNU
else
  SED_INPLACE=(-i '') # BSD/macOS
fi

# Substitute all placeholders in every file under the output dir.
# Uses `|` as the sed delimiter to avoid escaping the / in URLs.
find "$OUTPUT_DIR" -type f -print0 | while IFS= read -r -d '' f; do
  sed "${SED_INPLACE[@]}" \
    -e "s|{{SERVICE_NAME}}|$NAME|g" \
    -e "s|{{OWNER}}|$OWNER|g" \
    -e "s|{{GITHUB_ORG}}|$GITHUB_ORG|g" \
    -e "s|{{DESCRIPTION}}|$DESCRIPTION|g" \
    -e "s|{{IMAGE_TAG}}|$IMAGE_TAG|g" \
    -e "s|{{REPO_URL}}|$REPO_URL|g" \
    "$f"
done

echo "✓ Rendered to $OUTPUT_DIR"

# ---- next steps ----
cat <<EOF

Next steps:

1. Create the git repo (empty) at $REPO_URL

2. Initialise + push:
     cd $OUTPUT_DIR
     git init -b main
     git add .
     git commit -m "feat: initial commit from nodejs-fastify-svc template"
     git remote add origin $REPO_URL
     git push -u origin main

3. Copy the ArgoCD Application into the platform repo:
     cp $OUTPUT_DIR/argocd/application.yaml \\
        <platform-repo>/platform/argocd/apps/$NAME.yaml
     cd <platform-repo>
     git add platform/argocd/apps/$NAME.yaml
     git commit -m "feat: deploy $NAME"
     git push

4. Seed Vault with app config (BEFORE first ArgoCD sync, else pod crashloops):
     kubectl -n vault exec -it vault-0 -- \\
       env VAULT_TOKEN="\$VAULT_ROOT_TOKEN" \\
       vault kv put -mount=secret $OWNER/$NAME DUMMY_CONFIG=starter

5. Register the service in Backstage catalog (add to platform repo):
     Edit platform/argocd/apps/backstage.yaml → appConfig.catalog.locations
     Add:
       - type: url
         target: https://raw.githubusercontent.com/$GITHUB_ORG/$NAME/main/catalog-info.yaml
         rules: [ { allow: [Component] } ]
     Commit + push.

6. Wait ~3 min for ArgoCD to sync + verify:
     kubectl get pods -n $NAME
     Grafana → Explore → Loki: {app="$NAME"}
     Grafana → Explore → Tempo: search by service.name=$NAME
EOF
