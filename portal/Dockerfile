# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────
# Multi-stage build for the idp-portal Backstage app.
#
# Replaces the scaffolded packages/backend/Dockerfile (host-build
# pattern that assumes yarn install + yarn tsc + yarn build:backend
# were run on the host first). Our Phase 7 reusable CI/CD workflow
# does NOT run yarn before docker build — it treats the Dockerfile
# as the self-contained build definition. So this file runs the full
# install + compile + bundle inside docker.
#
# Stage layout:
#   1. deps:    cache yarn.lock + install deps once (reused by builder
#               if source changes but deps don't)
#   2. builder: compile TypeScript + run backend bundle step
#   3. runtime: Chainguard Node with the bundle + production deps only
#
# WHY Chainguard Node (Phase 8 Wave 3 Task 8W3.2 swap from node:22-trixie-slim):
#   Chainguard rebuilds their images on every upstream CVE fix in the
#   Wolfi-based distro. Wolfi ships significantly fewer system packages
#   than Debian Trixie, which means fewer transitive CVEs surface in
#   Trivy. Pre-swap we had 2 zlib CVEs suppressed; Chainguard's
#   node:latest-dev doesn't ship zlib as a user-accessible CVE at all.
#   Phase 9 EKS reproducibility concerns may pin to a specific digest
#   later; for now `latest-dev` moves with Chainguard's patch cadence.
#
# WHY `-dev` variant for runtime (vs the fully distroless `cgr.dev/chainguard/node:latest`):
#   The runtime stage runs `yarn workspaces focus --all --production`
#   at build time to install production-only deps into the image.
#   `yarn` is not in the distroless variant — it ships only the node
#   binary. Moving the `workspaces focus` step to the builder stage
#   would let us go full-distroless but requires re-engineering the
#   bundle layout. Phase 10 polish task.
#
# WHY swap `apt-get install` for `apk add`:
#   Chainguard images are Wolfi-based, not Debian-based. `apk` is
#   Wolfi's package manager (Alpine-descended, not glibc-incompatible —
#   Wolfi ships glibc, not musl, so native modules compile cleanly).
#
# Context: this Dockerfile expects docker build to be run with context
# = portal/ (project root for the Backstage workspace), NOT with
# context = repo root. The Phase 7 reusable workflow sets context to
# the service repo root; the CI wrapper for portal maps that to portal/.

# ─────────────────────────────────────────────────────────────────
# Stage 1: deps — install dependencies, cache yarn resolution
# ─────────────────────────────────────────────────────────────────
FROM cgr.dev/chainguard/node:latest-dev AS deps

WORKDIR /build

# Copy yarn infrastructure + lockfile first (cache-friendly)
COPY .yarn ./.yarn
COPY .yarnrc.yml package.json yarn.lock ./
COPY backstage.json ./
COPY packages/app/package.json ./packages/app/package.json
COPY packages/backend/package.json ./packages/backend/package.json

# Install OS deps native modules (better-sqlite3, tree-sitter) need
# to compile. Wolfi's apk conventions: `build-base` is the meta-package
# covering gcc + g++ + make (Alpine-descended naming; Debian equivalent
# is `build-essential`). `python3` and `sqlite-dev` separately.
#
# Chainguard's node:latest-dev default USER is root. We stay root
# through the deps + builder stages — switching to a lower-privilege
# user here runs into COPY-ownership semantics: COPY without --chown
# puts files as root:root regardless of current USER, so a later
# `USER node` + yarn install would fail with EACCES on node_modules/
# creation. The runtime stage below drops to node:node with --chown
# on every COPY.
RUN apk add --no-cache \
        build-base \
        python3 \
        sqlite-dev

# Install ALL deps (including devDeps — builder needs tsc etc.).
# Runs as root; cache mount uid/gid default (root) matches.
RUN --mount=type=cache,target=/root/.yarn-cache,sharing=locked \
    YARN_CACHE_FOLDER=/root/.yarn-cache \
    yarn install --immutable

# ─────────────────────────────────────────────────────────────────
# Stage 2: builder — compile TS + bundle backend
# ─────────────────────────────────────────────────────────────────
FROM deps AS builder

WORKDIR /build

# Copy source
COPY tsconfig.json ./
COPY packages ./packages
COPY plugins ./plugins
COPY examples ./examples
COPY app-config.yaml app-config.production.yaml ./

# Compile TypeScript (noEmit — just type check)
RUN yarn tsc

# Build the backend bundle (produces packages/backend/dist/bundle.tar.gz
# and packages/backend/dist/skeleton.tar.gz) — matches what the
# scaffolded Dockerfile's host-build step would have produced.
RUN yarn build:backend

# ─────────────────────────────────────────────────────────────────
# Stage 3: runtime — Chainguard Node dev with production deps + bundle
# ─────────────────────────────────────────────────────────────────
FROM cgr.dev/chainguard/node:latest-dev AS runtime

# Runtime OS deps: sqlite-libs for better-sqlite3 at runtime,
# ca-certificates for HTTPS calls.
USER root
RUN apk add --no-cache sqlite-libs ca-certificates
USER node

WORKDIR /app

# Copy yarn infrastructure + lockfile (production install needs it).
# Chainguard's `node` user is uid 65532 (not 1000 like the previous
# Debian base). COPY --chown reflects that.
COPY --chown=node:node --from=builder /build/.yarn ./.yarn
COPY --chown=node:node --from=builder /build/.yarnrc.yml /build/backstage.json ./
COPY --chown=node:node --from=builder /build/yarn.lock /build/package.json ./

# Copy the skeleton (per-package package.json files only, for yarn to
# resolve the workspace layout) + the actual backend bundle
COPY --chown=node:node --from=builder /build/packages/backend/dist/skeleton.tar.gz ./
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

# Install production-only deps (strips devDeps — much smaller runtime).
# uid=65532 matches Chainguard's `node` user.
ENV NODE_ENV=production
RUN --mount=type=cache,target=/home/node/.yarn-cache,sharing=locked,uid=65532,gid=65532 \
    YARN_CACHE_FOLDER=/home/node/.yarn-cache \
    yarn workspaces focus --all --production

# Examples (sample catalog data) + app-config
COPY --chown=node:node --from=builder /build/examples ./examples
COPY --chown=node:node --from=builder /build/app-config.yaml /build/app-config.production.yaml ./

# Backend bundle itself
COPY --chown=node:node --from=builder /build/packages/backend/dist/bundle.tar.gz ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz

EXPOSE 7007

# Entrypoint: Backstage backend serves on port 7007 by default.
# Merge both app-config files at runtime; environment-specific overrides
# (like database URL for prod) live in app-config.production.yaml.
CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]

# OCI labels for cross-tool traceability
LABEL org.opencontainers.image.title="idp-portal" \
      org.opencontainers.image.description="Backstage developer portal for the IDP" \
      org.opencontainers.image.source="https://github.com/kelechi-nwankpa/internal-developer-platform"
