# Phase 7 — CI/CD Golden Pipeline

- **Status:** ✅ Shipped 2026-10-10. First real service running the full CI/CD pipeline end-to-end: push → build → scan → sign → deploy → ArgoCD sync → healthy pods.
- **Started:** 2026-10-10 (ADR-0032)
- **Finished:** 2026-10-10 (same day, intensive single-session execution)
- **Duration:** ~1 calendar day, 1 focused session with substantial inline troubleshooting
- **Total AWS spend:** **$0** (still all on kind + GitHub Actions free tier)
- **Scope note:** Reusable workflow built + published, template skeleton updated + README documents the contract, platform-hello consumes the pipeline, 6 bugs banked and all fixed. Pre-existing cert-manager naming bug (bug #5) also fixed as a bonus. ArgoCD cosmetic drift on cert-manager resources (bug #6) deferred to Phase 8.

## Business problem

**Phase 6 shipped a service manually. Phase 7 removed the human from the loop.**

Before Phase 7, every change to `platform-hello` required: build the container locally, push to a registry by hand, bump the image tag in `kubernetes/deployment.yaml`, commit, push, wait for ArgoCD. ~15-20 minutes of error-prone glue work per deploy. No security scanning, no cryptographic signing, no audit trail of *what was built from what commit*.

Phase 7 replaces all of that with **one `git push`** that produces, within ~3 minutes:

- A multi-arch distroless container tagged `:sha-<7char>` of the triggering commit
- A Trivy CVE scan that blocks HIGH/CRITICAL by default
- A cosign keyless signature attested via Fulcio + Rekor transparency log
- A `kustomize edit set image` + `git commit` back to the service repo
- An ArgoCD sync that rolls new pods on the signed, scanned image

**One pipeline, N services.** The reusable workflow lives in the platform repo. Every service scaffolded from the golden path template calls it with a ~15-line wrapper. Changes to the pipeline (new scanner, new signer, new stage) propagate to every consumer automatically on next run.

## Target users of this phase

- **App engineers (Phase 7+).** Push code. Wait 3 minutes. New pods running. They never touch Docker, kubectl, or Argo.
- **Platform team.** Owners of `reusable-service-ci.yml`. One file is the leverage point for every service's security posture.
- **Security engineers.** The two primitives that make downstream enforcement possible (Trivy block + cosign signature) land here. Phase 8's Kyverno policies will require cosign-verified images, enforcing what this phase produces.
- **Portfolio narrative.** This is where the IDP goes from "it works" to "it's SOC-2-shaped." Reusable workflows, OIDC federation (no long-lived secrets), supply-chain signing, GitOps commit-back — all in one phase.

## Business value

- **~15 min manual deploy → ~3 min automated deploy** per code change. Developer flow uninterrupted.
- **Supply-chain security baked in from day one.** Every image shipped by this pipeline is CVE-scanned and cryptographically signed. The exception policy (`.trivyignore`) is explicit, dated, and reviewed.
- **Zero long-lived secrets in the pipeline.** OIDC federation means GitHub Actions auths to GHCR and cosign-signs via ephemeral tokens. No PATs, no service account keys to leak or rotate.
- **Immutable, reproducible deploys.** `:sha-<7char>` tags are per-commit — rolling back is `git revert`. Interview-friendly story.
- **The template now carries CI/CD contract-first.** Future services get the pipeline on day one with a documented set of prerequisites (lockfile, repo settings), not as a Phase-N retrofit.

## Architecture — what runs now

```text
                          GITHUB (control plane)
    ┌───────────────────────────────────────────────────────────────┐
    │                                                               │
    │  kelechi-nwankpa/platform-hello (service repo)                │
    │    .github/workflows/ci.yml  ──── calls ────┐                 │
    │                                             ▼                 │
    │  kelechi-nwankpa/internal-developer-platform (platform repo)  │
    │    .github/workflows/reusable-service-ci.yml                  │
    │      jobs: install-and-test                                   │
    │          → build (multi-arch distroless)                      │
    │          → scan (Trivy HIGH/CRITICAL blocks)                  │
    │          → push (ghcr.io, via OIDC-federated GITHUB_TOKEN)    │
    │          → sign (cosign keyless via Fulcio + Rekor)           │
    │          → update-manifest (kustomize edit + commit-back)     │
    │                                                               │
    │  ghcr.io/kelechi-nwankpa/platform-hello:sha-<7char>           │
    │    + signature manifest alongside each image                  │
    │    + Rekor transparency log entry per signature               │
    │                                                               │
    └───────────────────┬───────────────────────────────────────────┘
                        │ (git commit from pipeline)
                        ▼
    ┌───────────────────────────────────────────────────────────────┐
    │               KIND CLUSTER (data plane)                       │
    │                                                               │
    │  ArgoCD (polls service repo every ~3min)                      │
    │    → detects manifest change (newTag: sha-<7char>)            │
    │    → syncs Deployment                                         │
    │                                                               │
    │  platform-hello namespace                                     │
    │    → ReplicaSet rev:N (new ReplicaSet per deploy)             │
    │    → 2 pods running sha-<7char>                               │
    │    → Certificate Ready=True (cert-manager via SelfSigned)     │
    │                                                               │
    └───────────────────────────────────────────────────────────────┘
```

## Debugging arc — 6 bugs banked

Each bug surfaced a non-obvious contract, a wrong default, or a hidden quirk. All fixed; all documented.

### Bug 1 — Install+test failed: missing `package-lock.json`

- **Symptom:** First-ever CI run failed instantly: *"Dependencies lock file is not found in /home/runner/work/platform-hello/platform-hello. Supported file patterns: package-lock.json, npm-shrinkwrap.json, yarn.lock"*
- **Root cause:** The reusable workflow uses `actions/setup-node@v4` with `cache: 'npm'`. That requires a lockfile in the repo to compute a cache key. platform-hello was created in Phase 6 without ever running `npm install` locally, so no `package-lock.json` existed.
- **Fix:** `npm install --package-lock-only` → commit the lockfile (`bbd3113`).
- **Non-obvious learning:** The `cache: 'npm'` option is a **hidden contract** every service repo must honour. Template README now documents "commit your lockfile" as a repo-settings prerequisite.

### Bug 2 — Trivy action pinned to a version that doesn't exist

- **Symptom:** Scan job failed in 4 seconds: *"Unable to resolve action `aquasecurity/trivy-action@0.28.0`, unable to find version `0.28.0`"*
- **Root cause:** The pin was wrong twice over. Real tags use a `v` prefix (`v0.29.0`, not `0.29.0`), AND `0.28.0` was never released — the tag sequence jumps from v0.29.0 onward. The version came from memory, not verification.
- **Fix:** Query `curl /releases` on the trivy-action repo, pin to real `v0.36.0` (`ac9c294`).
- **Non-obvious learning:** **Reusable workflows called via `@main` are resolved at dispatch time, NOT re-fetched on re-run.** When I pushed the fix and clicked "Re-run failed jobs", GitHub replayed the originally-pinned reference — the fix never reached that run. Had to push an empty commit to force a fresh dispatch. This behaviour is **by design** (reproducible re-runs) but caught me out.

### Bug 3 — 15 CVEs blocked the scan (14 HIGH, 1 CRITICAL)

- **Symptom:** Once Trivy actually ran, it correctly refused to proceed: 1 CRITICAL + 14 HIGH vulnerabilities across OpenSSL, fastify, OpenTelemetry packages, and the fast-xml-parser transitive dep (pulled in by `@aws-sdk/client-s3`).
- **Root cause:** Phase 6 scaffolded platform-hello with versions that were current at template-write time but had since drifted months behind. OpenTelemetry 0.55.x in particular predated the SDK 2.x refactor; AWS SDK v3.700 bundled an old fast-xml-parser with a known XSS.
- **Fix (4 commits):**
  - `0e093a3` — bumped 9 deps: fastify 5.1→5.12.5, OTel stack 0.55→0.223/0.81, OTel resources 1.28→2.12 (API break), AWS SDK v3.700→3.1149, plus `.trivyignore` for 6 upstream-pending CVEs
  - `d2a5517` — observability.ts migration to OTel SDK 2.x API (`new Resource({...})` → `resourceFromAttributes({...})`)
  - `d705fb0` — pinned distroless base to SHA digest, defeating GHA buildx cache that was serving a stale layer
  - `fa9ffbd` — accepted all 6 openssl CVEs in `.trivyignore` (even "fixable" ones) because Google's distroless rebuilds lag Debian's security releases by days; weekly review cycle documented
- **Non-obvious learning:** **The pipeline doing its job IS success.** The CVE block prevented a demonstrably vulnerable image from reaching production. CVE IDs oscillate as Trivy's DB updates (same openssl advisories surfaced as 28389/28390 → 28387/28388 → 28389/28390 within a single day). The `.trivyignore` policy includes a comment warning future maintainers of this drift pattern. **Phase 8 escape hatch:** migrate to `cgr.dev/chainguard/node` which rebuilds hourly with the latest security patches; would eliminate the `.trivyignore` block entirely.

### Bug 4 — Green pipeline wrote a CORRUPT kustomize manifest

- **Symptom:** All 6 jobs ✅ green. But the committed `kustomization.yaml` had: `newTag: sha-$(echo "fa9ffbd620..." | cut -c1-7)` — a literal unexpanded shell expression that ArgoCD would try to pull as a tag.
- **Root cause:** The manifest-bump step defined `IMAGE_REF` in a YAML `env:` block containing `$(echo ...)`. **YAML `env:` values are stored as literal strings — shell expansion never happens there.** Expansion only happens inside `run:` blocks where a real shell is interpreting the commands.
- **Fix:** `bc1fcb1` — moved the SHA truncation into the `run:` block, where `$(echo ...)` actually works. Passed only Actions-context values (`FULL_SHA`, `IMAGE_REGISTRY`, `IMAGE_REPO`) through `env:`.
- **Non-obvious learning:** **A green pipeline is not a correct pipeline.** Exit codes miss output-level bugs. Phase 8 should add a post-condition check: assert `newTag =~ ^sha-[0-9a-f]{7}$` after the bump, fail the job if not.

### Bug 5 — Pre-existing cert-manager ClusterIssuer name mismatch (16 days latent)

- **Symptom:** While verifying ArgoCD sync, noticed yellow arrow on the Certificate resource. `kubectl get certificate -n platform-hello` showed `READY=False` for **16 days**. Error: *"Referenced ClusterIssuer not found: `selfsigned-cluster-issuer`"*.
- **Root cause:** Phase 2 installed the ClusterIssuer as `selfsigned`. The golden path template (and therefore every service scaffolded from it, including platform-hello) referenced the fictional name `selfsigned-cluster-issuer`. Phase 6's observability work used HTTP endpoints only; Phase 7's CI work didn't exercise TLS; the pod + Service + Deployment all reported Healthy regardless. **The bug was invisible for 16 days** until a routine ArgoCD tree verification revealed the yellow arrow.
- **Fix (2 commits across 2 repos):**
  - `f0e5dda` (platform repo) — template skeleton `certificate.yaml` + `ingress.yaml` corrected
  - `ed7c20d` (platform-hello) — same two files corrected in the live service
- **Non-obvious learning:** **A phase can ship "green" with a dormant bug if the paths exercised during the close-out don't cover every resource.** The Phase 6 close-out should have included "walk every Argo-managed resource and confirm green." Now it will. Also: **template bugs are 2-sided fixes** — platform repo + every consumer. Future scaffolded services will inherit the fix; existing services need the explicit cherry-pick (we have only one so far, so cheap).

### Bug 6 — ArgoCD spurious drift on cert-manager Certificate resource (DEFERRED to Phase 8)

- **Symptom:** After bug #5 is fixed, Certificate shows `READY=True` and Ingress serves TLS correctly, but ArgoCD UI persistently shows `OutOfSync` on the Certificate and Ingress resources.
- **Root cause:** cert-manager mutates the Certificate CR after creation (adds `status.conditions`, `metadata.finalizers`, etc.). ArgoCD's default diff treats these runtime-added fields as "drift from Git."
- **Status:** NOT FIXED. This is **cosmetic** — nothing is actually broken, pods run, TLS works, traffic flows. The real fix requires either `argocd.argoproj.io/sync-options: ServerSideApply=true` on the Application, or an `ignoreDifferences:` block. Both are Application-level global policy decisions better suited to Phase 8's security hardening wave (where Kyverno, Pod Security Standards, and the Chainguard migration will also require Application config changes).
- **Deferred to:** Phase 8.

## What's shipped

- `.github/workflows/reusable-service-ci.yml` — the pipeline (369 lines, 6 jobs, workflow_call only).
- `templates/nodejs-fastify-svc/skeleton/.github/workflows/ci.yml` — the ~15-line consumer wrapper.
- `templates/nodejs-fastify-svc/skeleton/README.md` — new "CI/CD" section with repo-settings prerequisites, event→jobs matrix, pipeline chain diagram, cosign verification command, rollback procedure.
- `platform-hello/.github/workflows/ci.yml` — first real consumer wrapper.
- `platform-hello/.trivyignore` — written exception policy for 6 upstream-pending openssl CVEs.
- `platform-hello/Dockerfile` — distroless base pinned to SHA digest with in-file rotation protocol.
- `docs/adr/0032-cicd-pipeline-reusable-workflow-oidc-cosign.md` — the design doc, 5 interlocking decisions locked.
- `platform-hello/package.json` — dep bumps for CVE remediation; lockfile regenerated.
- `platform-hello/src/observability.ts` — OTel SDK 2.x API migration (`resourceFromAttributes`).
- `platform-hello/kubernetes/certificate.yaml` + `ingress.yaml` — ClusterIssuer name fix.
- `templates/.../kubernetes/certificate.yaml` + `ingress.yaml` — same fix propagated to template.

## Deferred / tech debt

Each is explicit, scoped, and attached to a target phase or review cadence.

| # | Item | Target |
|---|---|---|
| 1 | ArgoCD spurious drift on cert-manager Certificates (bug #6) | Phase 8 (needs Application-level `ignoreDifferences:` or `ServerSideApply=true`; combine with Kyverno + PSS wave) |
| 2 | Chainguard base image migration (`cgr.dev/chainguard/node`) — would eliminate the `.trivyignore` openssl block | Phase 8 |
| 3 | Pin all third-party GitHub Actions to commit SHAs (not floating tags) — defeats supply-chain tag-moving attacks | Phase 8 |
| 4 | Add `--show-suppressed` to Trivy config so ignored CVEs print on every run — restores "visible and uncomfortable" property | Phase 8 or opportunistic |
| 5 | Post-condition check on manifest bump: assert `newTag =~ ^sha-[0-9a-f]{7}$` after `kustomize edit set image` — catches bugs like #4 | Phase 8 |
| 6 | Update Node 20 → Node 24 in all third-party actions (Node 20 deprecated per GHA runner images #14748); runners are already force-running them on Node 24 | Low priority — watch for actual breakage |
| 7 | `.trivyignore` review date 2026-10-17 — re-fetch Trivy output, remove entries whose upstream fixes landed, update CVE IDs if drifted | Weekly, until Chainguard migration |
| 8 | Base image digest rotation — monthly refresh of the pinned distroless SHA, documented procedure in-Dockerfile | Monthly |
| 9 | Phase 6 bug #5 lesson applied here: every future phase close-out should include "walk every Argo-managed resource and confirm green" | Process change |

## Retrospective

**Strengths:**

- Strategic intro up front — business problem → target users → architecture → components → data flow — before writing a single line of workflow YAML. Decisions were deliberate.
- ADR-0032 locked in 5 interlocking choices (reusable workflow, OIDC, tag strategy, scan-before-push, CI-commits-manifest) with alternatives considered and reasons for rejection documented.
- Reusable workflow pattern is high-leverage: one file controls every service's security posture. Changes propagate automatically.
- 6 bugs banked = 6 institutional-knowledge entries. Each has a commit, each explains the root cause, each includes a "non-obvious learning" takeaway for the Phase 7 close-out log.
- End-to-end verified: pipeline runs 6 jobs, pushes signed image, commits back, ArgoCD syncs, 2 pods healthy on new SHA, TLS cert issued. The full GitOps loop demonstrably closes.
- Bug #5 is a bonus win — a dormant Phase 2/6 bug caught + fixed in both template and consumer during Phase 7's verification pass. Phase 6 process change (walk every resource) will catch future ones.

**Weaknesses (deferred, not blockers):**

- `.trivyignore` entries are the honest trade-off, but the policy depends on an upstream (Google distroless) rebuild cadence we don't control. Chainguard migration in Phase 8 is the real fix.
- Bug #4 (shell expansion in `env:`) was a correctness bug the pipeline reported as green. Post-condition checks (deferred item #5) are the systemic fix.
- The `cache: 'npm'` hidden contract (bug #1) should ideally be a scaffolder-step in the template (`bin/render.sh` could run `npm install --package-lock-only` as part of generation). Currently documented in README; could be enforced.
- Node 20 deprecation annotations across every job are noise now, but will become errors when GitHub drops the forced-Node-24 fallback. Clock is ticking.
- No end-to-end integration test — e.g. after pipeline completes, poll for ArgoCD sync + hit `/healthz` on the Ingress. Would catch bugs like #5 and #6 automatically.

## ADRs written this phase

- [ADR-0032](../adr/0032-cicd-pipeline-reusable-workflow-oidc-cosign.md) — CI/CD pipeline: reusable workflow + OIDC + semver/SHA tags + CI-commits-manifest + Trivy/cosign

## Interview talking points

- *"How does your IDP's CI/CD actually work?"* — One `git push` → reusable workflow runs 6 jobs in the platform repo (test, build, scan, push, sign, update-manifest) → kustomize edit set image + commit back to the service repo → ArgoCD polls and syncs → new pods running the signed, scanned image. ~3 minutes end-to-end. The reusable workflow is called by a ~15-line wrapper in every service repo via `uses: platform-repo/...@main`, so one file controls every service's security posture.
- *"Walk me through a non-obvious bug you hit."* — The green-pipeline-wrong-output bug (#4). The manifest-bump step defined `IMAGE_REF` in a YAML `env:` block containing `$(echo "<sha>" | cut -c1-7)`. YAML `env:` values are literal strings — shell expansion never happens there. The pipeline exited 0 (kustomize happily accepted the literal), but it wrote a tag ArgoCD could never resolve. **Lesson: exit codes miss output-level bugs. Add post-condition assertions.**
- *"How do you handle security scanning blocking the pipeline?"* — Scan ran, found 15 CVEs (14 HIGH, 1 CRITICAL), blocked the build. First instinct is to lower the threshold or disable the scanner — both wrong. Right answer: remediate what you can (dep bumps, 9 of them, including a 1.x→2.x OTel SDK API migration), accept the rest with written justification (`.trivyignore` with reasons and review dates). The ignore file is not an escape hatch; it's a documented exception policy.
- *"How does your supply-chain signing work?"* — cosign keyless, no key management. Signs each pushed image by digest. The signer identity is the GitHub Actions workflow run (via OIDC federation to Fulcio for a short-lived cert), and the signature is logged publicly in Rekor's transparency log. Phase 8's Kyverno policy will require cosign verification before admission — so admitted images are provably from this pipeline's trusted workflow.
- *"Why reusable workflow instead of a template file?"* — Centralised ownership. If I need to add a new scanner, bump a third-party action, or change the signing policy, I PR the platform repo ONCE and every service gets it on next run. A template-copied workflow would require updating N service repos. Trade-off: reusable workflows pin to a ref at dispatch time (not re-fetched on re-run) — minor operational gotcha, documented in the Phase 7 close-out log.
- *"What's the GitOps commit-back pattern vs ArgoCD Image Updater?"* — I chose CI-commits-manifest over Image Updater because it keeps Argo's input (Git) as the single source of truth. Image Updater reads image registries directly and can mutate state outside Git, breaking "if it isn't in Git, it doesn't exist." Also: `kubectl diff` / git log on the manifest repo tells me exactly what's deployed, no polling the registry.

## LinkedIn post idea

**Hook:** *"First end-to-end run of my IDP's CI/CD pipeline today — 6 bugs along the way, each a portfolio-grade lesson."*

**Body:** Walk the arc.

- Bug 1: `cache: 'npm'` has a hidden contract I didn't document. One line fix, important teaching moment about reusable-workflow consumers.
- Bug 2: Pinned Trivy action to a version from memory — version didn't exist. Also learned reusable workflows pin at dispatch time, re-runs don't re-fetch.
- Bug 3: The pipeline did its job and blocked on 15 real CVEs. Remediated via 9 dep bumps including a 1.x→2.x OTel SDK API migration. `.trivyignore` for the 6 openssl CVEs we can't fix at the application layer.
- Bug 4: All 6 jobs green — but the pipeline silently wrote a corrupt manifest. YAML `env:` doesn't do shell expansion. **Green ≠ correct.**
- Bug 5: Found a 16-day-dormant cert-manager naming bug while verifying ArgoCD. Phase 6 never looked at the TLS cert, so it stayed invisible. Fixed in template AND consumer.
- Bug 6: cert-manager + ArgoCD cosmetic drift. Deferred to Phase 8.

**CTA:** Link to the phase log + ADR-0032. "This is the real-world CI/CD journey — not a happy-path README, but every rough edge documented."

## YouTube video idea

**Title:** *"Building a reusable CI/CD pipeline for an IDP — 6 bugs, 2 repos, 1 green loop"*

**Structure (25-35 min):**

1. Why reusable workflows beat template-copied workflows (platform engineering leverage story — 1 PR vs N PRs)
2. ADR-0032 walk-through: 5 interlocking decisions (reusable workflow, OIDC, SHA tags, scan-before-push, CI-commits-manifest)
3. Live first-run demo: push code → watch GitHub Actions tab → bug cascade
4. The 6-bug debugging arc, in order, each with the "non-obvious learning" callout
    - Lockfile contract
    - Trivy version + reusable-workflow dispatch pinning
    - CVE remediation (OTel 2.x API migration is the most visual)
    - Shell expansion in env block (green ≠ correct)
    - Pre-existing cert-manager naming mismatch
    - ArgoCD drift (and why I deferred to Phase 8)
5. End-to-end demo: push code → ~3 min later → signed, scanned, deployed pod
6. What Phase 8 (security hardening) will add

**Selling point:** The honesty about bug #6 (defer, not fix) and bug #5 (16-day-dormant, caught by routine verification) distinguishes this from happy-path demos.

## Next in project

**Immediate options:**

1. **Phase 4 Wave 2 — Crossplane ProviderConfig for MinIO.** Closes the Phase 6 bug 5 workaround (manual bucket + Secret). GitOps-complete storage provisioning. ~1-2 sessions.
2. **Phase 5 Wave 2 — Backstage custom image + plugins.** Unlocks Scaffolder click-to-create + ArgoCD/Crossplane plugin UI + Software Templates full flow. ~6-10 sessions.
3. **Phase 8 — Security hardening.** Kyverno + NetworkPolicy + Pod Security Standards + the ArgoCD drift fix (bug #6) + Chainguard base image + SHA pinning for all third-party actions. ~4-6 sessions. **Natural Phase 7 continuation** — most Phase 7 deferred items land here.
4. **Phase 9 — EKS promotion** (if Phase 8 is in good shape). Deploy the entire platform to real AWS, prove the ADR-0005 "same manifests, kind → EKS" promise.

**Session opener:** *"start Phase 4 Wave 2 MinIO ProviderConfig"* OR *"start Phase 5 Wave 2 Backstage polish"* OR *"start Phase 8 security hardening"* OR *"start Phase 9 EKS promotion"*.

## See also

- [ADR-0032](../adr/0032-cicd-pipeline-reusable-workflow-oidc-cosign.md) — pipeline design
- [ADR-0017](../adr/0017-cert-manager-issuer-strategy.md) — the issuer strategy, bug #5's root reference
- [ADR-0028](../adr/0028-backstage-install-and-image-strategy.md) — the `:latest` tech-debt pattern, parallel to Phase 7's `.trivyignore` exception policy
- [docs/phases/phase-6-golden-path.md](phase-6-golden-path.md) — the template this phase added CI/CD to
- [.github/workflows/reusable-service-ci.yml](../../.github/workflows/reusable-service-ci.yml) — the pipeline itself
- [templates/nodejs-fastify-svc/skeleton/.github/workflows/ci.yml](../../templates/nodejs-fastify-svc/skeleton/.github/workflows/ci.yml) — the wrapper every service inherits
- [github.com/kelechi-nwankpa/platform-hello](https://github.com/kelechi-nwankpa/platform-hello) — the first service through the pipeline, every commit on main now runs it
