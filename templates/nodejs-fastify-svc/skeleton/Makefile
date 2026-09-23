# Makefile — {{SERVICE_NAME}}
# editorconfig-checker-disable-file
# ^ Make continuation lines conventionally use tab + spaces for alignment
#   under the command; editorconfig-checker wants pure tabs. Disabled here.
# ─────────────────────────────────────────────────────────────────────
# One-command surface for the dev/test/build/docker workflow.
# Every real target is idempotent + safe to re-run.
# ─────────────────────────────────────────────────────────────────────

.PHONY: help install dev test build clean docker-build docker-run k8s-apply k8s-delete

# `make` with no args → help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ─────────────────────────────────────────────────────────────
# Development
# ─────────────────────────────────────────────────────────────

install: ## Install npm dependencies
	npm install

dev: ## Hot-reload dev server (tsx watch)
	npm run dev

test: ## Run tests (node --test dist)
	npm run test

build: ## Compile TypeScript → dist/
	npm run build

clean: ## Remove build artifacts + node_modules
	rm -rf node_modules dist coverage

# ─────────────────────────────────────────────────────────────
# Docker
# ─────────────────────────────────────────────────────────────

DOCKER_TAG ?= {{SERVICE_NAME}}:local

docker-build: ## Build container image (multi-stage distroless)
	docker build -t $(DOCKER_TAG) .

docker-run: docker-build ## Run container locally (needs .env)
	@if [ ! -f .env ]; then \
	  echo "ERROR: .env not found. Copy .env.example → .env + set OTel + AWS vars." >&2; \
	  exit 1; \
	fi
	docker run --rm -p 3000:3000 --env-file .env $(DOCKER_TAG)

# ─────────────────────────────────────────────────────────────
# Kubernetes (local — for iterating on manifests before ArgoCD sync)
# ─────────────────────────────────────────────────────────────
# In practice, ArgoCD deploys these — but `kubectl apply -k` is useful
# when iterating on manifest edits locally before committing.
# GitOps-first per CLAUDE.md §4: `k8s-apply` is a debugging tool, not
# a deployment mechanism.

NAMESPACE ?= {{SERVICE_NAME}}

k8s-apply: ## Apply k8s manifests (DEBUGGING ONLY — normal deploy is via ArgoCD)
	@echo "WARNING: applying manifests outside ArgoCD. GitOps drift will occur." >&2
	kubectl create namespace $(NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -k kubernetes/ -n $(NAMESPACE)

k8s-delete: ## Delete k8s manifests (namespace kept)
	@echo "WARNING: deleting outside ArgoCD → OutOfSync until next reconcile." >&2
	kubectl delete -k kubernetes/ -n $(NAMESPACE) --ignore-not-found
