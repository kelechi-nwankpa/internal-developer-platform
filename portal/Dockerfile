# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────
# Multi-stage build for the idp-portal Backstage app.
#
# Phase 8 Wave 3 Task 8W3.2: base swapped from node:22-trixie-slim
# (Debian) to cgr.dev/chainguard/wolfi-base + apk-installed Node 22.
#
# WHY wolfi-base + `apk add nodejs-22` instead of chainguard/node:
#   Root-caused across 4 CI iterations + a local repro (full story in
#   docs/phases/phase-8-security-hardening.md Wave 3 bugs):
#     - Chainguard's FREE tier only publishes `latest` tags; the
#       node:latest-dev image ships Node 26 (nodejs-26 apk package).
#     - Backstage's engines field allows "22 || 24" — and the older
#       native modules in its tree (tree-sitter 0.21, cpu-features
#       0.0.10) fail node-gyp compilation against Node 26's V8
#       headers. This was the real cause of the CI failures, NOT
#       missing build packages.
#     - Version-pinned images (node:22-dev) are Chainguard paid-tier
#       only (MANIFEST_UNKNOWN on free pulls).
#     - Wolfi's apk repo DOES ship versioned Node for free:
#       `apk add nodejs-22` → 22.x (22.23.2 at time of writing).
#   Local repro verified tree-sitter@0.21.1 + cpu-features@0.0.10 +
#   better-sqlite3 all compile cleanly on wolfi-base + nodejs-22 +
#   build-base + python3.
#
# WHY this keeps the Chainguard/Wolfi CVE story:
#   wolfi-base is the same distroless-lineage distro Chainguard's
#   images are built from — minimal package set, rebuilt on every
#   upstream CVE fix. The `nodejs-22` apk tracks the latest 22.x
#   patch, so we inherit Node security patches on rebuild while the
#   MAJOR stays pinned to the project standard (CLAUDE.md §10,
#   .nvmrc, Backstage engines).
#
# USER model (differs from the chainguard/node attempts):
#   wolfi-base defaults to root — so build stages (deps, builder)
#   run as root exactly like the old Debian file did, and the
#   COPY-without---chown → root-owned-files behavior is consistent
#   with the executing user. No permission juggling.
#   The runtime stage drops to Wolfi's standard `nonroot` user
#   (uid/gid 65532) with --chown on every COPY.
#
# Stage layout (unchanged):
#   1. deps:    cache yarn.lock + install deps once
#   2. builder: compile TypeScript + bundle backend
#   3. runtime: Node 22 + production deps + bundle, as nonroot
#
# Context: docker build context = portal/ (NOT repo root). The Phase 7
# reusable workflow maps docker-context: ./portal.

# ─────────────────────────────────────────────────────────────────
# Stage 1: deps — install dependencies, cache yarn resolution
# ─────────────────────────────────────────────────────────────────
FROM cgr.dev/chainguard/wolfi-base AS deps

# Node 22 (project-pinned major) + yarn-berry launcher (defers to the
# repo-pinned Yarn release via .yarnrc.yml yarnPath) + native-module
# build chain. `build-base` = Wolfi's gcc/g++/make meta-package.
RUN apk add --no-cache \
        nodejs-22 \
        npm \
        yarn-berry \
        build-base \
        python3 \
        sqlite-dev

WORKDIR /build

# Copy yarn infrastructure + lockfile first (cache-friendly).
# Runs as root (wolfi-base default) — COPY's root:root default
# ownership matches the executing user, so no --chown needed in
# build stages.
COPY .yarn ./.yarn
COPY .yarnrc.yml package.json yarn.lock ./
COPY backstage.json ./
COPY packages/app/package.json ./packages/app/package.json
COPY packages/backend/package.json ./packages/backend/package.json

# Install ALL deps (including devDeps — builder needs tsc etc.)
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
# and packages/backend/dist/skeleton.tar.gz).
RUN yarn build:backend

# ─────────────────────────────────────────────────────────────────
# Stage 3: runtime — Node 22 on Wolfi + production deps, as nonroot
# ─────────────────────────────────────────────────────────────────
FROM cgr.dev/chainguard/wolfi-base AS runtime

# Runtime deps: Node 22, yarn (for the production-focus install at
# image build time — a full-distroless runtime that drops yarn is the
# Phase 10 polish refactor), sqlite-libs for better-sqlite3's runtime
# linkage, ca-certificates for HTTPS.
RUN apk add --no-cache \
        nodejs-22 \
        yarn-berry \
        sqlite-libs \
        ca-certificates

# Wolfi convention: `nonroot` user, uid/gid 65532. Create /app owned
# by it before dropping privileges.
WORKDIR /app
RUN chown -R nonroot:nonroot /app
USER nonroot

# Copy yarn infrastructure + lockfile (production install needs it)
COPY --chown=nonroot:nonroot --from=builder /build/.yarn ./.yarn
COPY --chown=nonroot:nonroot --from=builder /build/.yarnrc.yml /build/backstage.json ./
COPY --chown=nonroot:nonroot --from=builder /build/yarn.lock /build/package.json ./

# Skeleton (per-package package.json files for workspace resolution)
COPY --chown=nonroot:nonroot --from=builder /build/packages/backend/dist/skeleton.tar.gz ./
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

# Install production-only deps (strips devDeps). uid/gid 65532 =
# Wolfi nonroot, so the shared cache mount is writable.
ENV NODE_ENV=production
RUN --mount=type=cache,target=/home/nonroot/.yarn-cache,sharing=locked,uid=65532,gid=65532 \
    YARN_CACHE_FOLDER=/home/nonroot/.yarn-cache \
    yarn workspaces focus --all --production

# Examples (sample catalog data) + app-config
COPY --chown=nonroot:nonroot --from=builder /build/examples ./examples
COPY --chown=nonroot:nonroot --from=builder /build/app-config.yaml /build/app-config.production.yaml ./

# Backend bundle itself
COPY --chown=nonroot:nonroot --from=builder /build/packages/backend/dist/bundle.tar.gz ./
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz

EXPOSE 7007

# Entrypoint: Backstage backend on 7007; both app-configs merged at
# runtime (env-specific overrides in app-config.production.yaml).
CMD ["node", "packages/backend", "--config", "app-config.yaml", "--config", "app-config.production.yaml"]

# OCI labels for cross-tool traceability
LABEL org.opencontainers.image.title="idp-portal" \
      org.opencontainers.image.description="Backstage developer portal for the IDP" \
      org.opencontainers.image.source="https://github.com/kelechi-nwankpa/internal-developer-platform"
