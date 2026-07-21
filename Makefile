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
# Local Kubernetes — kind cluster
# ─────────────────────────────────────────────────────────────
KIND_CLUSTER_NAME := idp
KIND_CONFIG       := platform/kind/kind-config.yaml
KIND_CONTEXT      := kind-$(KIND_CLUSTER_NAME)

.PHONY: kind-up
kind-up: ## create the local kind cluster from platform/kind/kind-config.yaml
	@printf "$(BLUE)==> Creating kind cluster '$(KIND_CLUSTER_NAME)'$(RESET)\n"
	@if kind get clusters 2>/dev/null | grep -qx $(KIND_CLUSTER_NAME); then \
		printf "$(YELLOW)   Cluster '$(KIND_CLUSTER_NAME)' already exists — skipping create.$(RESET)\n"; \
	else \
		kind create cluster --config $(KIND_CONFIG); \
	fi
	@printf "$(BLUE)==> Waiting for control-plane node Ready$(RESET)\n"
	@kubectl --context $(KIND_CONTEXT) wait --for=condition=Ready node --all --timeout=2m
	@printf "$(GREEN)==> Cluster '$(KIND_CLUSTER_NAME)' is up (context: $(KIND_CONTEXT))$(RESET)\n"

.PHONY: kind-down
kind-down: ## destroy the local kind cluster
	@printf "$(BLUE)==> Deleting kind cluster '$(KIND_CLUSTER_NAME)'$(RESET)\n"
	@kind delete cluster --name $(KIND_CLUSTER_NAME)

.PHONY: kind-status
kind-status: ## show kind cluster + node + system pod state
	@printf "$(BLUE)==> Cluster:$(RESET)\n"
	@kind get clusters | sed 's/^/  /'
	@printf "\n$(BLUE)==> Nodes:$(RESET)\n"
	@kubectl --context $(KIND_CONTEXT) get nodes
	@printf "\n$(BLUE)==> System pods:$(RESET)\n"
	@kubectl --context $(KIND_CONTEXT) get pods -A

# ─────────────────────────────────────────────────────────────
# ArgoCD — bootstrap into the local kind cluster
#
# Install is server-side apply because the ApplicationSet CRD's serialised
# form exceeds Kubernetes' 256KB annotation limit — the older client-side
# `kubectl apply` fails with "metadata.annotations: Too long". See ADR-0014.
# ─────────────────────────────────────────────────────────────
ARGOCD_VERSION  := v3.4.5
ARGOCD_MANIFEST := https://raw.githubusercontent.com/argoproj/argo-cd/$(ARGOCD_VERSION)/manifests/install.yaml

.PHONY: argocd-install
argocd-install: ## install ArgoCD ($(ARGOCD_VERSION)) into kind-idp via server-side apply
	@printf "$(BLUE)==> Verifying kubectl context is '$(KIND_CONTEXT)'$(RESET)\n"
	@current=$$(kubectl config current-context 2>/dev/null || echo none); \
	if [ "$$current" != "$(KIND_CONTEXT)" ]; then \
		printf "$(RED)   Current context is '$$current', expected '$(KIND_CONTEXT)'.$(RESET)\n"; \
		printf "$(RED)   Run 'make kind-up' first, or 'kubectl config use-context $(KIND_CONTEXT)'.$(RESET)\n"; \
		exit 1; \
	fi
	@printf "$(BLUE)==> Creating namespace 'argocd' (idempotent)$(RESET)\n"
	@kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
	@printf "$(BLUE)==> Applying ArgoCD $(ARGOCD_VERSION) via server-side apply$(RESET)\n"
	@kubectl apply --server-side --force-conflicts -n argocd -f $(ARGOCD_MANIFEST)
	@printf "$(BLUE)==> Waiting for deployments to become Available (5 min)$(RESET)\n"
	@kubectl wait --for=condition=Available deploy --all -n argocd --timeout=5m
	@printf "$(BLUE)==> Waiting for application-controller StatefulSet to be Ready (5 min)$(RESET)\n"
	@kubectl rollout status statefulset/argocd-application-controller -n argocd --timeout=5m
	@printf "$(GREEN)==> ArgoCD $(ARGOCD_VERSION) is up in namespace 'argocd'$(RESET)\n"
	@printf "\nNext:\n"
	@printf "  make argocd-status         # verify pod + CRD state\n"
	@printf "  make argocd-password       # print bootstrap admin password (rotate it, then delete secret)\n"
	@printf "  make argocd-portforward    # open UI on https://localhost:8080 (blocking)\n"

.PHONY: argocd-uninstall
argocd-uninstall: ## remove ArgoCD (namespace + CRDs; destroys any Application/AppProject/ApplicationSet data)
	@printf "$(YELLOW)==> Deleting namespace 'argocd' (cascades all in-namespace objects)$(RESET)\n"
	@kubectl delete namespace argocd --ignore-not-found
	@printf "$(YELLOW)==> Deleting ArgoCD CRDs (destroys any Applications, AppProjects, ApplicationSets)$(RESET)\n"
	@kubectl delete crd \
		applications.argoproj.io \
		applicationsets.argoproj.io \
		appprojects.argoproj.io \
		--ignore-not-found
	@printf "$(GREEN)==> ArgoCD removed$(RESET)\n"

.PHONY: argocd-status
argocd-status: ## show ArgoCD pod, CRD, and secret state
	@printf "$(BLUE)==> Pods:$(RESET)\n"
	@kubectl get pods -n argocd 2>/dev/null || printf "$(RED)  namespace 'argocd' not found — run 'make argocd-install'$(RESET)\n"
	@printf "\n$(BLUE)==> CRDs:$(RESET)\n"
	@kubectl get crd 2>/dev/null | grep argoproj || printf "$(RED)  no ArgoCD CRDs found$(RESET)\n"
	@printf "\n$(BLUE)==> Secrets (argocd-initial-admin-secret should be absent after password rotation):$(RESET)\n"
	@kubectl get secrets -n argocd 2>/dev/null || true

.PHONY: argocd-password
argocd-password: ## print the bootstrap admin password (only exists until deleted per security hygiene)
	@if kubectl -n argocd get secret argocd-initial-admin-secret >/dev/null 2>&1; then \
		printf "$(YELLOW)Bootstrap admin password (rotate + delete this secret ASAP):$(RESET)\n"; \
		kubectl -n argocd get secret argocd-initial-admin-secret \
			-o jsonpath='{.data.password}' | base64 -d; \
		printf "\n"; \
	else \
		printf "$(GREEN)No bootstrap admin secret found — good, it was deleted after rotation.$(RESET)\n"; \
		printf "Use your rotated admin password, or 'argocd account update-password' to change it again.\n"; \
	fi

.PHONY: argocd-portforward
argocd-portforward: ## port-forward argocd-server → https://localhost:8080 (blocks; Ctrl-C to stop)
	@printf "$(BLUE)==> Port-forwarding argocd-server → https://localhost:8080$(RESET)\n"
	@printf "$(YELLOW)   Accept the self-signed cert warning in the browser. Ctrl-C to stop.$(RESET)\n"
	@kubectl -n argocd port-forward svc/argocd-server 8080:443

.PHONY: argocd-bootstrap-root
argocd-bootstrap-root: ## apply the app-of-apps root Application (one-time; everything else is GitOps after this)
	@printf "$(BLUE)==> Verifying kubectl context is '$(KIND_CONTEXT)'$(RESET)\n"
	@current=$$(kubectl config current-context 2>/dev/null || echo none); \
	if [ "$$current" != "$(KIND_CONTEXT)" ]; then \
		printf "$(RED)   Current context is '$$current', expected '$(KIND_CONTEXT)'.$(RESET)\n"; \
		exit 1; \
	fi
	@printf "$(BLUE)==> Applying platform/argocd/root-app.yaml (the only manual apply in the platform lifecycle)$(RESET)\n"
	@kubectl apply -f platform/argocd/root-app.yaml
	@printf "$(GREEN)==> root Application applied.$(RESET)\n"
	@printf "\nWatch it reconcile:\n"
	@printf "  argocd app get root         # sync status, health, and any children\n"
	@printf "  argocd app list             # every managed Application on the cluster\n"

# ─────────────────────────────────────────────────────────────
# Portal (implemented in Phase 5)
# ─────────────────────────────────────────────────────────────
.PHONY: portal-run
portal-run: ## [Phase 5+] run Backstage locally
	@printf "$(RED)Not yet implemented — arrives in Phase 5.$(RESET)\n"
	@exit 1
