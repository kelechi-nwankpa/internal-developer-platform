# 0019 — Install HashiCorp Vault (standalone + manual unseal) as the ESO backend on kind

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

[ADR-0018](0018-external-secrets-install-via-helm.md) installed ESO but ESO is idle without a `SecretStore` pointing at a real backend. On EKS the backend is trivially AWS Secrets Manager with IRSA (Phase 9). On **kind local dev**, we need something different — AWS creds don't belong on a developer laptop, and mocking Secrets Manager with LocalStack has its own long tail of caveats.

We evaluated five backend options for kind in Task 2.4.a and chose **local Vault**. This ADR records *how* we install Vault — mode, storage, unseal strategy, feature toggles — because Vault's Helm chart has multiple viable configurations and the choice determines what we learn.

Vault is doing two jobs here:

1. **Practical:** be a secrets backend for ESO on kind so we can prove the whole ESO pipeline end-to-end.
2. **Pedagogical:** teach Vault ops (init, unseal, auth methods, policies) as part of the platform engineer's toolkit.

## Decision drivers

1. **Depth of learning.** We picked Vault over the Fake provider specifically to learn Vault; the install mode must match that intent.
2. **Realism.** Should reflect what a real Vault deployment looks like — not a demo shortcut.
3. **Local-first.** Must work offline, must be cheap to rip out and rebuild.
4. **Compatibility with ESO.** Vault's Kubernetes auth method is the target integration — Vault must expose a compatible surface.
5. **Reversible.** If we later hate the ceremony of manual unseal, moving to auto-unseal is a one-line Helm values change — not a Vault re-install.

## Options considered

### Option A — Standalone mode + manual unseal (chosen)

Vault runs as a single-replica Deployment with `standalone` config. Uses `file` storage backend on a PVC (kind's local-path-provisioner). Vault is sealed at startup — human must run `vault operator init` once (generates 5 unseal keys + 1 root token) and `vault operator unseal <key>` three times after every pod restart.

- Pros: Real Vault operations. Every ceremony (init, unseal, key management) exercised. Data persists across pod restarts. Realistic ops posture — this is what a fresh Vault deployment looks like before any operator has thought about auto-unseal. Deepest portfolio value.
- Cons: Vault pod restart = platform partly broken until human unseals. On kind, `kind delete cluster && kind create cluster` wipes the PVC → re-init + re-seed test secrets every time (~5 minutes of friction). This is intentional; treat it as recovery drill practice.

### Option B — Standalone mode + Kubernetes auto-unseal

Same as A but Vault stores its unseal key in a Kubernetes Secret in the vault namespace. On restart, Vault self-unseals.

- Pros: No human intervention on restart. Data persists. Realistic minus the unseal ceremony.
- Cons: The Kubernetes Secret holding the unseal key is base64-encoded, not encrypted. Anyone with `get secret` on the vault namespace can unseal Vault. This is the "circular trust" pattern that's fine for local dev but a big anti-pattern in prod (where you'd use AWS KMS auto-unseal or Vault Transit auto-unseal against a separate Vault). More importantly for our purpose: it skips the manual unseal drill we specifically wanted to practice.

### Option C — Dev mode

Vault runs with `-dev` flag: in-memory storage, auto-unseals at startup, root token = `root`, all data wiped on pod restart.

- Pros: Fastest to a working ESO integration. Zero ceremony. No key management.
- Cons: Nothing to learn. Every restart = re-seed everything. `dev` mode is explicitly documented as "not for anything real." Portfolio narrative is thin: *"I ran Vault in dev mode"* is not a resume line.

### Option D — HA mode (Raft)

Three-replica Vault with Raft consensus for storage and auto-leader-election.

- Pros: Prod-shaped HA topology. Realistic for large deployments.
- Cons: Three replicas on a single-node kind cluster with anti-affinity rules = 2 pods `Pending` forever. Wastes local resources. Right for EKS (if we had a self-hosted Vault story on EKS, which we don't — we use AWS Secrets Manager there). Wrong for kind.

### Option E — Skip Vault, use ESO Fake provider

Rejected at the Task 2.4.a stage — see ADR-0018 discussion. Recording here for completeness.

## Decision

**Option A — standalone + manual unseal.** Deepest learning, most realistic ops posture, matches the "we picked Vault over Fake for depth" logic at every level.

**Auto-unseal migration path:** if the friction genuinely bites (e.g., we hit a stretch where we're rebuilding the kind cluster daily for other reasons), the swap to Option B is one line: `server.standalone.config` gets a `seal "kubernetes"` stanza and unseal happens automatically. **Don't do it prematurely.** The friction is the point until it's demonstrably not.

## Consequences

- **Positive:** Every Vault operation exercised — init, seal/unseal, root token management, auth method configuration (Kubernetes auth in Task 2.4.h), policy writing (Task 2.4.i). PVC-backed data persists across Vault pod restarts (only cluster rebuilds wipe it). Realistic Vault deployment shape. Uninstall = `argocd app delete vault && kubectl delete ns vault` — clean.
- **Negative:** Every Vault pod restart requires manual unseal (`kubectl exec -n vault vault-0 -- vault operator unseal <key>` × 3). Unseal keys must be stored somewhere — treated as sensitive dev-only material; keeping them in a password manager or 1Password entry. `kind delete cluster` requires re-init and re-seed of test secrets. Portfolio recording (Task 2.9) needs to include the manual unseal step or explicitly note it as a one-time-per-restart operation.
- **Neutral:** Injector + CSI features of the Vault chart are explicitly disabled — ESO is the "get secrets into pods" mechanism, not Vault Agent. Enabling both would be redundant. On EKS in Phase 9, none of this Vault install exists — that entire backend is AWS Secrets Manager. This install is kind-only.

## When to revisit

- **If we find the manual unseal drill has taught its lesson.** Swap to Option B (k8s auto-unseal) via one Helm values change. Trigger: "I know what unseal is, I know why it matters, I no longer benefit from doing it manually."
- **If we adopt Vault on EKS instead of AWS Secrets Manager.** Then we'd graduate to HA mode with AWS KMS auto-unseal. Different ADR entirely — not planned for the current roadmap.
- **If OpenBao (the community BSL-fork of Vault) becomes the community standard.** Consider swapping. Not today; Vault's community + docs are still deeper.
- **If we need Vault's PKI engine for internal cert issuance** (as an alternative to cert-manager for internal certs). Then Vault becomes strategic, not just an ESO backend, and the install choices may need to shift.

## Related decisions

- [ADR-0015](0015-argocd-app-of-apps-pattern.md) — the deployment pattern this Application slots into.
- [ADR-0016](0016-cert-manager-install-via-helm.md) — parent decision on Helm-via-ArgoCD; this ADR follows.
- [ADR-0018](0018-external-secrets-install-via-helm.md) — ESO install; this ADR gives ESO its backend.
- [ADR-0020](0020-eso-backend-strategy.md) — *pending* — the per-environment SecretStore config (Vault ClusterSecretStore for kind, AWS Secrets Manager ClusterSecretStore for EKS). Written when we ship Task 2.4.j.

## References

- [Vault — Kubernetes deployment guide (standalone)](https://developer.hashicorp.com/vault/docs/platform/k8s/helm/run)
- [Vault Helm chart values reference](https://developer.hashicorp.com/vault/docs/platform/k8s/helm/configuration)
- [Vault seal / unseal reference](https://developer.hashicorp.com/vault/docs/concepts/seal)
- [Vault Kubernetes auth method](https://developer.hashicorp.com/vault/docs/auth/kubernetes)
- [BSL license FAQ (from HashiCorp)](https://www.hashicorp.com/license-faq)

## Licensing note (BSL)

Vault v1.15+ (including our v2.x install) uses the **Business Source License**. **Personal, portfolio, internal-company use is fully permitted.** Only offering "competing hosted Vault-as-a-service" is restricted (i.e., you can't be Amazon Web Services selling Vault to their customers). None of our uses trigger the restrictions. Documenting so interview conversations about "did you know Vault switched to BSL?" have a defensible answer ready.

## Interview framing

The one-liner: *"On kind local dev, our ESO backend is HashiCorp Vault installed in standalone mode with manual unseal. Standalone over HA because it's a single-node cluster. Manual unseal over auto-unseal because I specifically wanted to practice the seal ceremony — every senior Platform Engineer has had to unseal a Vault at 2am and I'd rather learn that muscle memory in local dev where nothing depends on it. On EKS we swap the whole backend for AWS Secrets Manager via IRSA — no Vault deployment on the EKS side; ESO's provider abstraction makes the swap one-file config change."*
