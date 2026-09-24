# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────
# Multi-stage build for {{SERVICE_NAME}}
# Stage 1 (builder): Node 22 with npm — install + compile TS
# Stage 2 (runtime): distroless nodejs22 — no shell, no libc,
#                    non-root user. Small attack surface.
# ─────────────────────────────────────────────────────────────────────

# ---- Stage 1: build ----
FROM node:22-slim AS builder

WORKDIR /app

# Install deps first (cached layer if package files unchanged)
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && \
    cp -r node_modules /app/node_modules_prod && \
    npm install --ignore-scripts

# Copy source + compile
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---- Stage 2: runtime ----
# distroless nodejs22:nonroot — no shell, runs as UID 65532
FROM gcr.io/distroless/nodejs22-debian12:nonroot

WORKDIR /app

# Copy prod deps only (not dev)
COPY --from=builder --chown=nonroot:nonroot /app/node_modules_prod ./node_modules
COPY --from=builder --chown=nonroot:nonroot /app/dist ./dist
COPY --from=builder --chown=nonroot:nonroot /app/package.json ./

# Distroless nodejs images use `node` as ENTRYPOINT. Just pass the script.
CMD ["dist/index.js"]

EXPOSE 3000

# Kubernetes labels (OCI standard)
LABEL org.opencontainers.image.title="{{SERVICE_NAME}}" \
      org.opencontainers.image.description="{{DESCRIPTION}}" \
      org.opencontainers.image.source="https://github.com/{{GITHUB_ORG}}/{{SERVICE_NAME}}"
