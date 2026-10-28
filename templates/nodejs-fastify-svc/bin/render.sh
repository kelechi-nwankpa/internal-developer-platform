#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# render.sh — DEPRECATED (Phase 5 Wave 3)
#
# This script no longer works. Phase 5 Wave 3 converted skeleton/ from
# sed-style {{PLACEHOLDER}} tokens to Backstage Scaffolder Nunjucks
# syntax (${{ values.X }}). The sed substitutions this script used to
# apply would no-op against the new tokens.
#
# Use Backstage instead:
#   1. Open http://localhost:3000 (or https://backstage.idp...)
#   2. Click Create → "Node.js + Fastify service (golden path)"
#   3. Fill the form → Submit
#   4. Scaffolder creates the service repo, opens a PR against the
#      platform repo for the ArgoCD Application, and registers the
#      Component in the Backstage catalog.
#
# Pre-Scaffolder sed-rendering logic is preserved in git history
# (`git log --all templates/nodejs-fastify-svc/bin/render.sh`) if you
# ever need the manual recipe for an airgapped environment.
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

echo "ERROR: bin/render.sh is DEPRECATED (Phase 5 Wave 3)." >&2
echo "       Use Backstage Create (click-to-create flow) instead." >&2
echo "       See the file header for details." >&2
exit 1
