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
#   3. runtime: node:22-slim with the bundle + production deps only
#
# WHY node:22 (not node:24 like the scaffold):
#   - CLAUDE.md pins Node 22 LTS for the whole project
#   - Backstage root package.json engines allows "22 || 24"
#   - 22 is the current LTS; 24 is the newer release but less stable
#
# WHY not distroless like platform-hello:
#   - Backstage backend needs libsqlite3 (SQLite plugin), apt + glibc
#     for native modules (keytar, better-sqlite3, tree-sitter grammars).
#     Distroless doesn't ship those; adding them defeats the "small
#     attack surface" story. Phase 8 security hardening could migrate
#     via Chainguard Node image which includes glibc + minimal apt.
#
# Context: this Dockerfile expects docker build to be run with context
# = portal/ (project root for the Backstage workspace), NOT with
# context = repo root. The Phase 7 reusable workflow sets context to
# the service repo root; the CI wrapper for portal maps that to portal/.

# ─────────────────────────────────────────────────────────────────
# Stage 1: deps — install dependencies, cache yarn resolution
# ─────────────────────────────────────────────────────────────────
FROM node:22-trixie-slim AS deps

WORKDIR /build

# Copy yarn infrastructure + lockfile first (cache-friendly)
COPY .yarn ./.yarn
COPY .yarnrc.yml package.json yarn.lock ./
COPY backstage.json ./
COPY packages/app/package.json ./packages/app/package.json
COPY packages/backend/package.json ./packages/backend/package.json

# Install OS deps native modules need
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

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
# and packages/backend/dist/skeleton.tar.gz) — matches what the
# scaffolded Dockerfile's host-build step would have produced.
RUN yarn build:backend

# ─────────────────────────────────────────────────────────────────
# Stage 3: runtime — node:22-slim with production deps + bundle
# ─────────────────────────────────────────────────────────────────
FROM node:22-trixie-slim AS runtime

# Runtime OS deps: libsqlite3 for the SQLite plugin, ca-certificates
# for HTTPS calls to GHCR/GitHub/etc.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libsqlite3-0 \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Switch to the unprivileged `node` user (uid 1000) that the base image provides
USER node
WORKDIR /app

# Copy yarn infrastructure + lockfile (production install needs it)
COPY --chown=node:node --from=builder /build/.yarn ./.yarn
COPY --chown=node:node --from=builder /build/.yarnrc.yml /build/backstage.json ./
COPY --chown=node:node --from=builder /build/yarn.lock /build/package.json ./

# Copy the skeleton (per-package package.json files only, for yarn to
# resolve the workspace layout) + the actual backend bundle
COPY --chown=node:node --from=builder /build/packages/backend/dist/skeleton.tar.gz ./
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

# Install production-only deps (strips devDeps — much smaller runtime)
ENV NODE_ENV=production
RUN --mount=type=cache,target=/home/node/.yarn-cache,sharing=locked,uid=1000,gid=1000 \
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
