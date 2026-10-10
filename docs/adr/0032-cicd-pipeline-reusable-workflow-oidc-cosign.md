# 0032 — CI/CD pipeline: reusable workflow + OIDC + semver/SHA tags + CI-commits-manifest + Trivy/cosign

- **Status:** Accepted
- **Date:** 2026-10-10
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Phase 6 shipped the first real service (`platform-hello`) through the golden path template — but every deploy is still manual: `docker build` locally, `docker push` to GHCR, edit `kubernetes/deployment.yaml` to bump the image tag, `git commit`, `git push`. A 5-step human workflow with a Docker build in the middle. **Any second developer or a code change at 2am breaks instantly.**

Phase 7's job is to automate the loop so that **application `git push` → automatic build + test + scan + sign + push → manifest bump → ArgoCD deploy → observability picks up the new version. Zero humans.**

Five intertwined decisions:

1. **Workflow structure** — reusable workflow in the platform repo (DRY) vs copy-paste per service (self-contained).
2. **Authentication** to GHCR + git commit-back — OIDC federation (no secrets) vs stored PAT.
3. **Image tag strategy** — SHA per build + semver on release vs just one of the two.
4. **Deploy trigger mechanism** — CI commits updated manifest vs Argo CD Image Updater vs targetRevision=HEAD.
5. **Security gates** — Trivy scan + cosign keyless signing vs scan-only vs neither.

These need to be decided together because they constrain each other (OIDC federation enables keyless cosign; CI-commits-manifest requires write permissions that only make sense with OIDC; etc.).

## Decision drivers

1. **Portfolio-defensible answer to "how do you deploy?"** The interview answer should be "automated pipeline with security gates, GitOps apply, zero human in the loop." Not "I run three commands."
2. **Second-service onboarding cost.** Phase 6 template produced `platform-hello` in a few hours. The CI pipeline should take seconds to adopt for the next service, not hours.
3. **Supply-chain story.** Image provenance, SBOM-ready, signature-verifiable. Phase 8 Kyverno will enforce signature verification at admission — CI needs to actually sign.
4. **No stored secrets anywhere.** Project principle (ADR-0009 established this for AWS; same for GitHub). OIDC federation is the modern pattern.
5. **GitOps-first (CLAUDE.md §4).** ArgoCD must remain the deploy mechanism; the pipeline just prepares the state git shows.
6. **Rollback must be trivial.** Pin SHA, re-commit, done. Semver tags support intentional releases.

## Options considered

### Decision 1 — Workflow structure

#### Option A — Reusable workflow in platform repo + thin wrapper per service (chosen)

- Pipeline logic lives in `kelechi-nwankpa/internal-developer-platform/.github/workflows/reusable-service-ci.yml`.
- Service repos reference it via `uses: kelechi-nwankpa/internal-developer-platform/.github/workflows/reusable-service-ci.yml@main`.
- Wrapper per service is ~15 lines: just inputs (service name, image repo path, test command).

**Pros:**

- Pipeline updates (new scanner, new signing method, new stage) propagate to every service automatically.
- Platform team authors the pattern once; app teams never maintain CI boilerplate.
- Matches how real platform engineering orgs operate — "paved road" for CI.

**Cons:**

- Reusable-workflow syntax has quirks (secrets must be explicitly passed; permissions inherit, not merge).
- Debugging a reusable workflow is harder — logs live in two places (consuming repo + source repo).
- Pinning to `@main` means breaking changes in the reusable workflow break every service. Mitigation: pin to SHAs in service wrappers once the workflow stabilises.

#### Option B — Full workflow copied into every service repo (rejected)

Each service's `.github/workflows/ci.yml` has the full pipeline inline. The template skeleton ships the full workflow.

- **Pros:** Self-contained, trivial to debug, service team can diverge if needed.
- **Cons:** Changes require touching N service repos. "Add trivy scan" becomes an N-repo PR fan-out. Scales badly.
- **Rejected because:** Portfolio pattern is to centralise. "Reusable workflow" is also a more interview-defensible choice.

### Decision 2 — Authentication to GHCR + git commit-back

#### Option C — OIDC federation (chosen)

- GitHub Actions requests a short-lived token via `permissions: id-token: write` + `contents: write` + `packages: write`.
- `docker/login-action` uses the GitHub token with GHCR scope.
- `actions/checkout` + `actions/github-script` use the GitHub token for the manifest commit-back.
- No secrets stored anywhere.

**Pros:**

- Zero credentials to rotate / leak / lose.
- Industry-standard supply-chain pattern (SLSA, OpenSSF).
- Matches ADR-0009 (GitHub OIDC → AWS) pattern already established.

**Cons:**

- GHCR permissions need to be enabled per repo (Settings → Actions → Workflow permissions → "Read and write").
- Debugging token scope issues can be opaque (401 without clear "you need X scope" messaging — bug 3 of Phase 6 was exactly this).

#### Option D — PAT stored in GitHub Secrets (rejected)

Create a `GHCR_TOKEN` PAT with `write:packages`, store in each repo's Secrets, use in `docker/login-action`.

- **Pros:** Simpler to set up; works for private repos / older GitHub plans.
- **Cons:** Secret to rotate every 90 days (Dependabot can nag but not auto-rotate). Can leak if an action is compromised. Explicitly against ADR-0009's "no stored credentials" principle.
- **Rejected because:** Portfolio value + the no-stored-secrets principle.

### Decision 3 — Image tag strategy

#### Option E — Both semver + git SHA (chosen)

- Every build pushes `:sha-<7-char-sha>` (unique per commit).
- Tagged releases (`git tag v1.2.3 && git push --tags`) also push `:v1.2.3`.
- Manifest references SHA tag by default (precise rollback target).
- Semver tag is for human-friendly release references + Dependabot bumps.

**Pros:**

- Every commit is uniquely addressable (SHA).
- Semver releases support rollback-to-known-good via familiar tag.
- Standard pattern across all CNCF projects.

**Cons:**

- Double the GHCR storage (minor — layers are shared, just tags differ).
- Semver tag workflow is additional complexity (requires `v*` tag push to trigger a second workflow or extra job).

#### Option F — Just git SHA (rejected)

Every deploy references `:sha-abc1234`. No semver concept.

- **Pros:** Simpler.
- **Cons:** Loses the "pin to release v1.2.3" ergonomics. Hard to communicate "we're on version X" to stakeholders.
- **Rejected because:** Portfolio demos often reference "deploy v1.2.3" — losing semver is a storytelling cost.

### Decision 4 — Deploy trigger mechanism

#### Option G — CI commits updated image tag to service repo's manifest (chosen)

Pipeline runs:

```bash
cd kubernetes
kustomize edit set image platform-hello=ghcr.io/${{ github.repository_owner }}/${{ repo }}:sha-${{ github.sha }}
git commit -am "chore: deploy ${{ github.sha }}"
git push
```

ArgoCD polls git (default 3-min interval), sees new commit, syncs, pod rolls.

**Pros:**

- Explicit audit trail — every deploy is a git commit (`git log kubernetes/`).
- Rollback is `git revert` of that commit.
- Same pattern works for ANY service — no per-service adapter.
- Separation of concerns: CI prepares state, ArgoCD applies state.

**Cons:**

- Each pipeline run produces a git commit on `main` — commit history is noisier (mitigation: use conventional-commit `chore:` prefix so release-note generators can filter).
- Potential race condition if two PRs merge simultaneously — second pipeline's `git push` could reject with "non-fast-forward" (mitigation: `git pull --rebase` before push, or use `actions/github-script` with retry).

#### Option H — Argo CD Image Updater (rejected)

Separate controller watches image registries, mutates `Application` manifests via Argo's git-write-back.

- **Pros:** No pipeline logic for manifest updates. "Just push image, Image Updater does the rest."
- **Cons:** Adds a controller + CRDs to the cluster. Opaque — the manifest bump happens off-cluster via Image Updater's own git commits. Harder to audit.
- **Rejected because:** CI-commits-manifest is simpler + more explicit; Image Updater is overkill for one service.

#### Option I — `targetRevision: HEAD` + manual manifest edit (rejected)

Service repo's Application points at HEAD; `deployment.yaml` has image tag already correct; every deploy requires manual YAML edit before git push.

- **Rejected because:** Defeats the purpose of CI/CD.

### Decision 5 — Image scanning + signing

#### Option J — Trivy scan + cosign keyless signing (chosen)

- **Trivy** (`aquasecurity/trivy-action@master`) scans the built image for CVEs. Fail on HIGH + CRITICAL.
- **cosign** (`sigstore/cosign-installer@v3`) signs the image with GitHub OIDC identity. Signatures logged to Rekor transparency log. No key management — identity attestation signed by Fulcio.

**Pros:**

- Modern supply-chain security — SLSA L2 compatible.
- Keyless signing means no secret to manage/rotate/compromise.
- Phase 8 Kyverno + sigstore-policy-controller can enforce "only cosign-signed images allowed."
- Trivy catches the easiest wins (known CVEs in base image + dependencies).

**Cons:**

- First build fails if base image has a known CRITICAL CVE (common — mitigation: distroless base + regular `trivy db update`).
- Cosign signatures add ~1 KB per image; negligible but worth noting.
- Rekor is public — anyone can see our image provenance. Fine for OSS, worth noting for proprietary later.

#### Option K — Trivy only (rejected)

Scan but don't sign.

- **Rejected because:** Half-measure — Phase 8 wants signature verification. Doing it now sets up the whole chain.

#### Option L — Neither (rejected)

Ship insecure, add later.

- **Rejected because:** Portfolio defensibility. "Oh I'll secure it later" is a weak interview answer.

## Decision

**Full combo: Option A + C + E + G + J.**

- Reusable workflow in platform repo at `.github/workflows/reusable-service-ci.yml`
- Thin wrapper in each service repo's `.github/workflows/ci.yml` (~15 lines)
- OIDC federation for GHCR push + git commit-back + cosign signing
- Image tag strategy: `sha-<7char>` every build + `v<semver>` on tagged release
- CI commits updated image tag to service repo's `kubernetes/deployment.yaml` via `kustomize edit set image`
- Trivy scan blocks on HIGH + CRITICAL CVEs
- cosign keyless signs every pushed image (both SHA and semver tags)

### Rollout order (per Phase 7 sub-task)

1. **Task 7.2** — build the reusable workflow (platform repo). Standalone, testable by invocation from a scratch repo.
2. **Task 7.3** — add thin wrapper + README section to the template skeleton. Future services inherit automatically.
3. **Task 7.4** — patch `platform-hello`'s existing `.github/workflows/ci.yml` placeholder to adopt the new wrapper. First real consumer.
4. **Task 7.5** — push a trivial code change (e.g. bump a log message) → observe pipeline run → verify new image + manifest commit + pod roll + Grafana shows new version. End-to-end validation.
5. **Task 7.6** — Phase 7 close-out.

### Repo-settings prerequisites (per service repo)

- **Workflow permissions:** Settings → Actions → General → Workflow permissions → "Read and write permissions" + "Allow GitHub Actions to create and approve pull requests."
- **Branch protection on main** (optional for MVP, enabled in Phase 8): require PR + 1 approval + CI pass before merge.

## Consequences

- **Positive:** Second service costs ~10 min to onboard CI (just the wrapper + repo settings). Phase 6's "scaffold + deploy" story becomes "scaffold + push + prod" with zero extra config.
- **Positive:** No credentials in GitHub Secrets. Full OIDC chain. ADR-0009 pattern extended consistently.
- **Positive:** Supply-chain story matures — scan + sign + attestation (via Rekor). Phase 8 Kyverno closes the loop with enforcement.
- **Positive:** Explicit audit trail via git log — every deploy is a commit, revert is `git revert <sha>`.
- **Negative:** Commit history on `main` includes `chore: deploy <sha>` commits for every merge. Mitigation: filter in release-note tooling via conventional-commit `chore:` prefix.
- **Negative:** Pipeline latency — Trivy scan + cosign sign + manifest commit chain is ~5-7 min end-to-end. Acceptable for MVP; Phase 10 could optimise.
- **Negative:** Reusable workflow pinned to `@main` means platform-repo breaking changes break every service. Mitigation: pin to SHAs once stable; CI contract versioning in Phase 9+.
- **Negative:** First build after a new CVE drops may fail — needs manual base-image bump. Trade-off accepted.
- **Neutral:** GitHub Actions free tier (public repos) covers this easily. Cost: $0.

## When to revisit

- **When a second service ships.** Prove the "reusable workflow + thin wrapper" assumption with real second consumer.
- **When Phase 8 ships Kyverno + sigstore-policy-controller.** Verify end-to-end: unsigned image → admission refused.
- **When a reusable workflow release breaks a service.** Switch service wrappers from `@main` to SHA pins + add CI versioning policy.
- **When Argo Rollouts lands (Phase 10 candidate).** Blue-green and canary need pipeline changes — update reusable workflow.
- **When we migrate off GitHub Actions.** Unlikely for this project; but if we did (self-hosted runners, Jenkins), the reusable-workflow pattern is specific to GitHub Actions. The design would need adaptation.

## Related decisions

- [ADR-0009](0009-github-oidc-federation.md) — GitHub OIDC federation for AWS. This ADR extends the same pattern to GHCR + git commit-back.
- [ADR-0011](0011-ecr-immutable-tags-per-domain-repos.md) — immutable image tags. We extend to GHCR with SHA (immutable) + semver (immutable).
- [ADR-0031](0031-golden-path-template-nodejs-fastify.md) — template design. CI wrapper in the skeleton is a direct extension.
- [ADR-0014](0014-argocd-raw-install-vs-helm.md) — ArgoCD install. The CI-commits-manifest pattern feeds ArgoCD's normal reconciliation.
- [CLAUDE.md §4](../../CLAUDE.md) — GitOps-first. CI never applies manifests directly; it only prepares the git state ArgoCD reads from.
- [CLAUDE.md §9](../../CLAUDE.md) — no stored secrets. OIDC federation satisfies this.

## References

- [GitHub Actions reusable workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows)
- [GitHub OIDC → GHCR auth](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [cosign keyless signing (sigstore)](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/)
- [Rekor transparency log](https://docs.sigstore.dev/logging/overview/)
- [Trivy container scanning](https://aquasecurity.github.io/trivy/)
- [kustomize edit set image](https://kubectl.docs.kubernetes.io/references/kustomize/cmd/edit_set_image/)

## Interview framing

The one-liner: *"Phase 7 wires CI/CD for every service produced by our golden path template. Reusable workflow in the platform repo + a 15-line wrapper per service — write once, consume everywhere. OIDC federation to GHCR means no stored credentials; cosign keyless signing with Rekor attestation means verifiable image provenance; Trivy scans block HIGH/CRITICAL CVEs. The pipeline commits updated image tags back to the service repo, so ArgoCD sees the change via its normal git-sync — no out-of-band Image Updater controller, no `kubectl apply` outside GitOps. End-to-end: dev pushes code, pipeline runs ~5 min, new version live in Grafana. Rollback is `git revert`. This is the DevX layer that makes the whole 'platform engineering' claim actually mean something."*
