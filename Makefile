# Makefile — the one-command surface for this project.
#
# Philosophy:
#   Someone new to this repo should type `make` and see every action they can
#   take. No memorising CLI incantations, no hunting through the README. If a
#   command isn't in `make help`, it doesn't exist.
#
# Safety:
#   SHELL is bash with `-eu -o pipefail` so a failed pipeline step aborts the
#   whole rule. The default `sh -c` gives silent partial failures — we don't.

SHELL       := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# ─────────────────────────────────────────────────────────────
# Variables
# ─────────────────────────────────────────────────────────────
NODE_VERSION := $(shell cat .nvmrc 2>/dev/null || echo unknown)

# ANSI colours for readability in `make help`.
BLUE   := \033[1;34m
GREEN  := \033[1;32m
YELLOW := \033[1;33m
RED    := \033[1;31m
RESET  := \033[0m

# ─────────────────────────────────────────────────────────────
# Help — self-documenting menu built from `## description` comments
# ─────────────────────────────────────────────────────────────
.PHONY: help
help: ## show this help
	@printf "$(BLUE)Internal Developer Platform — Makefile$(RESET)\n\n"
	@printf "Usage: make <target>\n\n"
	@grep -E '^[a-zA-Z_/-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-16s$(RESET) %s\n", $$1, $$2}'
	@printf "\n"

# ─────────────────────────────────────────────────────────────
# Local development environment
# ─────────────────────────────────────────────────────────────
.PHONY: bootstrap
bootstrap: ## one-time developer setup — install pre-commit hooks, verify tools
	@printf "$(BLUE)==> Verifying prerequisites$(RESET)\n"
	@command -v git >/dev/null 2>&1 || { printf "$(RED)git is required$(RESET)\n"; exit 1; }
	@command -v pre-commit >/dev/null 2>&1 || { printf "$(RED)pre-commit is required. Install: brew install pre-commit$(RESET)\n"; exit 1; }
	@command -v node >/dev/null 2>&1 || { printf "$(RED)node is required (see .nvmrc)$(RESET)\n"; exit 1; }
	@printf "$(BLUE)==> Installing pre-commit git hook$(RESET)\n"
	@pre-commit install
	@printf "$(GREEN)==> Bootstrap complete$(RESET)\n"

.PHONY: check
check: ## verify tool versions match project pins
	@printf "%-14s %s\n" "Tool" "Detected"
	@printf "%-14s %s\n" "----" "--------"
	@printf "%-14s %s\n" "node"       "$$(node --version 2>/dev/null || echo 'NOT INSTALLED')"
	@printf "%-14s %s\n" "docker"     "$$(docker --version 2>/dev/null || echo 'NOT INSTALLED')"
	@printf "%-14s %s\n" "git"        "$$(git --version 2>/dev/null || echo 'NOT INSTALLED')"
	@printf "%-14s %s\n" "pre-commit" "$$(pre-commit --version 2>/dev/null || echo 'NOT INSTALLED')"
	@printf "%-14s %s\n" "kind"       "$$(kind --version 2>/dev/null || echo 'NOT INSTALLED (needed from Phase 2)')"
	@printf "%-14s %s\n" "kubectl"    "$$(kubectl version --client 2>/dev/null | head -1 || echo 'NOT INSTALLED (needed from Phase 2)')"
	@printf "%-14s %s\n" "helm"       "$$(helm version --short 2>/dev/null || echo 'NOT INSTALLED (needed from Phase 2)')"
	@printf "%-14s %s\n" "aws"        "$$(aws --version 2>/dev/null || echo 'NOT INSTALLED (needed from Phase 1)')"
	@printf "%-14s %s\n" "cdk"        "$$(cdk --version 2>/dev/null || echo 'NOT INSTALLED (needed from Phase 1)')"
	@printf "\nProject pins node to $(NODE_VERSION) (from .nvmrc).\n"

# ─────────────────────────────────────────────────────────────
# Linting — same pre-commit hooks that gate CI
# ─────────────────────────────────────────────────────────────
.PHONY: lint
lint: ## run every pre-commit hook against every file
	@pre-commit run --all-files

.PHONY: lint-fix
lint-fix: ## run pre-commit and auto-fix what it can (whitespace, EOL, etc.)
	@pre-commit run --all-files || true
	@printf "$(YELLOW)==> Re-run 'make lint' to verify all issues are resolved.$(RESET)\n"

# ─────────────────────────────────────────────────────────────
# Cleanup
# ─────────────────────────────────────────────────────────────
.PHONY: clean
clean: ## remove generated artefacts (cdk.out, dist, build, node_modules)
	@printf "$(YELLOW)==> Removing generated artefacts$(RESET)\n"
	@rm -rf cdk.out dist build node_modules .yarn/cache
	@printf "$(GREEN)==> Clean complete$(RESET)\n"

# ─────────────────────────────────────────────────────────────
# AWS lifecycle (implemented in Phase 1)
# ─────────────────────────────────────────────────────────────
.PHONY: aws-up
aws-up: ## [Phase 1+] deploy the AWS baseline (CDK)
	@printf "$(RED)Not yet implemented — arrives in Phase 1.$(RESET)\n"
	@exit 1

.PHONY: aws-down
aws-down: ## [Phase 1+] destroy every AWS resource for this project
	@printf "$(RED)Not yet implemented — arrives in Phase 1.$(RESET)\n"
	@exit 1

.PHONY: cost
cost: ## [Phase 1+] show current AWS spend for this project
	@printf "$(RED)Not yet implemented — arrives in Phase 1.$(RESET)\n"
	@exit 1

# ─────────────────────────────────────────────────────────────
# Local Kubernetes (implemented in Phase 2)
# ─────────────────────────────────────────────────────────────
.PHONY: kind-up
kind-up: ## [Phase 2+] create a local kind cluster
	@printf "$(RED)Not yet implemented — arrives in Phase 2.$(RESET)\n"
	@exit 1

.PHONY: kind-down
kind-down: ## [Phase 2+] destroy the local kind cluster
	@printf "$(RED)Not yet implemented — arrives in Phase 2.$(RESET)\n"
	@exit 1

# ─────────────────────────────────────────────────────────────
# Portal (implemented in Phase 5)
# ─────────────────────────────────────────────────────────────
.PHONY: portal-run
portal-run: ## [Phase 5+] run Backstage locally
	@printf "$(RED)Not yet implemented — arrives in Phase 5.$(RESET)\n"
	@exit 1
