# 0020 — ESO backend strategy: Vault on kind, AWS Secrets Manager on EKS

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

[ADR-0018](0018-external-secrets-install-via-helm.md) installed the ESO operator; [ADR-0019](0019-vault-install-for-eso-kind-backend.md) installed Vault as a backend for it. This ADR closes the loop by specifying **which backend serves which purpose in which environment** — i.e., the per-environment `SecretStore` strategy.

The choice matters because `SecretStore` (or `ClusterSecretStore`) is what actually gives ESO work to do. Different environments will have different backends for good reasons:

- **kind (local dev)** — no AWS credentials belong on a laptop; we have Vault installed locally as an ESO-compatible backend.
- **EKS (staging/prod, Phase 9)** — AWS Secrets Manager is native, integrates with KMS from [Phase 1's KmsStack](../adr/0008-customer-managed-kms-keys.md) for envelope encryption, and authenticates via IRSA (established in [ADR-0009](0009-github-oidc-federation.md)).

The same `ExternalSecret` YAML in a workload's namespace can reference either backend — the `spec.secretStoreRef.name` field is the only thing that changes. ESO's provider abstraction means the workload doesn't care whether its password comes from Vault or Secrets Manager.

## Decision drivers

1. **Realism per environment.** kind must use something that works locally offline; EKS must use something production-grade.
2. **Zero AWS credentials on kind.** Static AWS creds in a Kubernetes Secret is an anti-pattern; IRSA doesn't work on kind.
3. **Same `ExternalSecret` shape.** Workloads should not need environment-specific templating; only the `secretStoreRef.name` should vary.
4. **Migration path from kind → EKS.** Should be a per-cluster ClusterSecretStore change, not a per-workload rewrite.
5. **Least privilege at the backend.** Each ClusterSecretStore should have a scoped policy/IAM role, not god-mode credentials.

## Options considered

Because there are two environments and multiple backends, we're actually choosing a **matrix** of options — one row per environment.

### Environment: kind

#### Option A — Vault via k8s auth method (chosen)

- ClusterSecretStore points at `http://vault.vault.svc:8200`, k8s auth method, role `eso-reader`.
- Pros: Real backend interaction. ESO's Vault provider exercised. Zero external deps. See ADR-0019 for the deeper Vault install rationale.
- Cons: Requires Vault install (ADR-0019). Vault must be unsealed for ESO to work; a sealed Vault means ExternalSecrets stall.

#### Option B — ESO Fake provider

- ClusterSecretStore uses the built-in Fake provider (values inline in the SecretStore spec).
- Pros: Zero setup beyond ESO itself.
- Cons: Rejected at ADR-0018 stage. Not a real backend interaction.

#### Option C — AWS Secrets Manager with static creds in a Secret

- ClusterSecretStore points at real AWS with static credentials.
- Cons: Static AWS creds on a dev laptop = well-established anti-pattern. Also incurs real AWS API costs during dev.

### Environment: EKS (Phase 9)

#### Option D — AWS Secrets Manager via IRSA (planned, activation deferred)

- ClusterSecretStore points at AWS Secrets Manager in eu-west-1, with an IRSA-annotated ServiceAccount that assumes a scoped IAM role. Role permits `secretsmanager:GetSecretValue` on specific ARNs only.
- Pros: Native AWS. KMS-encrypted at rest (via KmsStack from Phase 1). Integrates with AWS Secrets Manager rotation Lambdas. No static creds. Auditable via CloudTrail.
- Cons: Requires the EKS cluster + Phase 1's `KmsStack` deployed. Requires an IAM role definition per environment. Phase 9 work.

#### Option E — Vault on EKS via k8s auth method

- Deploy Vault on EKS too, use the same ClusterSecretStore shape as kind.
- Pros: Consistency across environments. Vault's PKI + dynamic secrets features become available for future use cases.
- Cons: We now have to run Vault as a stateful workload on EKS with proper HA, KMS auto-unseal, storage backend selection (integrated Raft), disaster recovery. Considerable operational surface. Doesn't fit the "cloud-native everywhere possible" posture of this project.

### Environment: EKS + Vault (rejected)

Some deployments run both AWS Secrets Manager AND Vault on EKS — Vault for internal PKI/dynamic secrets, Secrets Manager for AWS-integrated secrets like RDS credentials. Deferred as a Phase 8+ discussion; not a Phase 2 concern.

## Decision

**Matrix decision:**

| Environment | ClusterSecretStore(s) | Auth |
|---|---|---|
| kind (local dev, now) | `vault-kv` | k8s auth method + `eso-reader` Vault role |
| EKS (Phase 9) | `aws-secrets-manager` | IRSA + scoped IAM role |

**Both** ClusterSecretStores can coexist on the same cluster if needed (e.g., a Phase 9 EKS deploy that keeps Vault around for internal dynamic secrets AND uses Secrets Manager for AWS-integrated ones). Every `ExternalSecret` in a workload's namespace picks its store via `spec.secretStoreRef.name`.

## Consequences

- **Positive:** Real backend on both sides. Same `ExternalSecret` shape everywhere; per-workload rewrites when changing environments are zero. On EKS: KMS-at-rest, IAM-scoped access, CloudTrail audit — all first-class. On kind: full Vault operations exercised.
- **Negative:** Two different auth models to understand (Vault k8s auth vs AWS IRSA). Two different backend admin surfaces (Vault CLI/UI vs AWS Console/CLI). Both are useful skills; still adds cognitive overhead vs a single-backend world.
- **Neutral:** Workloads that need `secretStoreRef.name: vault-kv` on kind will need `secretStoreRef.name: aws-secrets-manager` on EKS. Two options for handling this in Phase 6 golden-path templates: (a) parameterise via Helm/Kustomize values, (b) name both stores the same (`platform-secrets`) with different providers per env. Deferred to Phase 6 when the templates land.

## When to revisit

- **Phase 9 EKS activation.** Add `platform/external-secrets/clustersecretstore-aws.yaml` with the IRSA + IAM role wiring. Same wrapper Application (`external-secrets-stores`) picks it up.
- **If we adopt Vault on EKS too.** Then both ClusterSecretStores exist there; workloads pick per-secret based on where the source of truth lives (AWS-managed secrets → Secrets Manager; app-managed → Vault).
- **If AWS Secrets Manager rate limits or cost become issues.** Consider AWS Parameter Store (cheaper, less feature-rich) as an alternative. Add a third ClusterSecretStore.
- **If we bring in a new provider (Doppler, 1Password, GCP Secret Manager) for a specific integration.** Add another ClusterSecretStore, don't rewrite existing ones.

## Related decisions

- [ADR-0018](0018-external-secrets-install-via-helm.md) — the ESO install this ADR configures.
- [ADR-0019](0019-vault-install-for-eso-kind-backend.md) — the Vault install that backs the kind ClusterSecretStore.
- [ADR-0008](0008-customer-managed-kms-keys.md) — KMS keys that will encrypt Secrets Manager secrets on EKS.
- [ADR-0009](0009-github-oidc-federation.md) — the IRSA pattern the EKS ClusterSecretStore will reuse.

## References

- [ESO — Vault provider docs](https://external-secrets.io/latest/provider/hashicorp-vault/)
- [ESO — AWS Secrets Manager provider docs](https://external-secrets.io/latest/provider/aws-secrets-manager/)
- [ESO — ClusterSecretStore vs SecretStore](https://external-secrets.io/latest/api/clustersecretstore/)
- [Vault — Kubernetes auth method](https://developer.hashicorp.com/vault/docs/auth/kubernetes)

## Interview framing

The one-liner: *"Our ESO backend is per-environment: HashiCorp Vault on kind (k8s auth + policy-scoped role) and AWS Secrets Manager on EKS (IRSA + scoped IAM role). Same `ExternalSecret` shape everywhere — workloads reference a `secretStoreRef.name`, and that's the only thing that changes between environments. The provider abstraction is the whole point of ESO over provider-specific tools like Vault Secrets Operator. Real backend on both sides, zero static AWS credentials anywhere."*
