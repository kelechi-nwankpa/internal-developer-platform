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

# AWS region and CDK app location — override on the command line if needed:
#   make aws-up AWS_REGION=us-east-1
AWS_REGION ?= eu-west-1
CDK_DIR    := infra

# List of stacks we destroy when tearing down between sessions. CostStack is
# deliberately EXCLUDED — its Budgets + Cost Anomaly monitors are free and
# stand between us and a surprise $200 bill. Use `make aws-nuke` when even
# CostStack should go.
WORKLOAD_STACKS := VpcStack KmsStack IamStack ClusterStack RegistryStack DnsStack

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
aws-up: ## deploy every CDK stack to $(AWS_REGION) in dependency order
	@printf "$(BLUE)==> Verifying AWS credentials$(RESET)\n"
	@aws sts get-caller-identity >/dev/null 2>&1 \
		|| { printf "$(RED)AWS credentials not set. Run 'aws configure' or 'aws sso login'.$(RESET)\n"; exit 1; }
	@printf "$(BLUE)==> Bootstrapping CDK in $(AWS_REGION) (idempotent)$(RESET)\n"
	@cd $(CDK_DIR) && AWS_REGION=$(AWS_REGION) npx cdk bootstrap
	@printf "$(BLUE)==> Deploying all stacks to $(AWS_REGION)$(RESET)\n"
	@cd $(CDK_DIR) && AWS_REGION=$(AWS_REGION) npx cdk deploy --all --require-approval broadening
	@printf "$(GREEN)==> aws-up complete. Run 'make aws-down' at session end to stop billing.$(RESET)\n"

.PHONY: aws-diff
aws-diff: ## show what CDK would change without deploying
	@cd $(CDK_DIR) && AWS_REGION=$(AWS_REGION) npx cdk diff

.PHONY: aws-status
aws-status: ## list every CloudFormation stack in $(AWS_REGION) and its state
	@aws cloudformation list-stacks \
		--region $(AWS_REGION) \
		--stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE CREATE_IN_PROGRESS UPDATE_IN_PROGRESS DELETE_IN_PROGRESS ROLLBACK_IN_PROGRESS \
		--query 'StackSummaries[*].[StackName,StackStatus,LastUpdatedTime||CreationTime]' \
		--output table

.PHONY: aws-down
aws-down: ## destroy every workload stack (KEEPS CostStack — Budgets stay armed)
	@printf "$(YELLOW)==> This will destroy: $(WORKLOAD_STACKS)$(RESET)\n"
	@printf "$(YELLOW)    CostStack is preserved (free; keeps Budgets armed).$(RESET)\n"
	@printf "$(YELLOW)    KMS keys enter a 7-day pending-deletion window.$(RESET)\n"
	@printf "$(YELLOW)    Route53 zone will be replaced with new NS on next deploy.$(RESET)\n"
	@printf "$(YELLOW)    Continue? [y/N] $(RESET)"
	@read confirm && [ "$$confirm" = "y" ] || { printf "$(RED)==> Aborted.$(RESET)\n"; exit 1; }
	@cd $(CDK_DIR) && AWS_REGION=$(AWS_REGION) npx cdk destroy $(WORKLOAD_STACKS) --force
	@printf "$(GREEN)==> aws-down complete. CostStack still up; billing dropping.$(RESET)\n"

.PHONY: aws-nuke
aws-nuke: ## destroy EVERYTHING including CostStack. Use only when tearing down for good
	@printf "$(RED)==> This will destroy EVERY stack INCLUDING CostStack (guardrails).$(RESET)\n"
	@printf "$(RED)    You will lose Budgets alarms and Cost Anomaly monitoring.$(RESET)\n"
	@printf "$(RED)    Continue? Type 'nuke' to confirm: $(RESET)"
	@read confirm && [ "$$confirm" = "nuke" ] || { printf "$(RED)==> Aborted.$(RESET)\n"; exit 1; }
	@cd $(CDK_DIR) && AWS_REGION=$(AWS_REGION) npx cdk destroy --all --force
	@printf "$(GREEN)==> aws-nuke complete. Account back to bootstrap state.$(RESET)\n"

.PHONY: cost
cost: ## show current AWS spend for Project=idp resources (month-to-date)
	@START=$$(date +'%Y-%m-01'); \
	END=$$(date +'%Y-%m-%d'); \
	printf "$(BLUE)==> Project=idp spend from $$START to $$END, by service$(RESET)\n"; \
	aws ce get-cost-and-usage \
		--time-period Start=$$START,End=$$END \
		--granularity MONTHLY \
		--metrics BlendedCost \
		--group-by Type=DIMENSION,Key=SERVICE \
		--filter '{"Tags":{"Key":"Project","Values":["idp"]}}' \
		--region us-east-1 \
		--query 'ResultsByTime[0].Groups[*].[Keys[0],Metrics.BlendedCost.Amount]' \
		--output table
	@START=$$(date +'%Y-%m-01'); \
	END=$$(date +'%Y-%m-%d'); \
	printf "\n$(BLUE)==> Total ACCOUNT spend from $$START to $$END$(RESET)\n"; \
	aws ce get-cost-and-usage \
		--time-period Start=$$START,End=$$END \
		--granularity MONTHLY \
		--metrics BlendedCost \
		--region us-east-1 \
		--query 'ResultsByTime[0].Total.BlendedCost.[Amount,Unit]' \
		--output text

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
