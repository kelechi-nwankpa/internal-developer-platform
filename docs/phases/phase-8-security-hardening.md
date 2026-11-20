# Phase 8 — Security hardening

Removes the dev-mode escape hatches Wave 3 banked, replaces admin
credentials with scoped service accounts, and in later waves adds
cluster-wide policy enforcement + supply-chain hardening + CVE
remediation.

Shipped in waves — each wave is independently demonstrable + commits
one specific class of debt.

## Business problem (phase-wide)

The platform works end-to-end at Phase 5 Wave 3 but ships as a
dev-mode prototype. Phase 5 Wave 3 explicitly banked:

- `auth.legacyGuestToken: true` on Backstage
- `backend.auth.dangerouslyDisableDefaultAuthPolicy: true` on Backstage
- ArgoCD plugin authenticated as **chart-generated admin**
- No cluster-wide policy engine (any pod can run as root, `:latest`,
  mount hostPath, bypass resource limits)
- No NetworkPolicy (every pod can reach every other pod cross-namespace)
- Backstage shipped with 35 suppressed CVE transitives awaiting a
  resolutions sweep

Phase 8 pays each of those debts.

## Phase 8 Wave 1 — Backstage auth hardening

**Status:** ✅ Shipped 2026-11-16 (actually completed over multiple sessions
2026-11-11 → 2026-11-16 due to 11-day calendar gap).

**Primary deliverable:** Replace guest sign-in + admin ArgoCD creds
with real per-user + per-service identity, remove both "dangerously"
auth flags, prove the chain end-to-end via the Backstage ArgoCD
Deployment tab rendering real sync state through the scoped token.

### Design decisions locked in (user-confirmed A/B/B/B at phase open)

- **A — GitHub OAuth for Backstage sign-in.** Reuses GitHub as the
  identity source (same primitive the Scaffolder's GitHub App uses
  for machine identity). Rejected: generic OIDC (needs external IdP),
  Dex (over-engineering for solo portfolio).
- **B — No guest fallback alongside OAuth.** The whole point of Wave 1
  is removing the escape hatches; a Guest tile defeats it. If GitHub
  OAuth is down, the operator fixes GitHub OAuth, not works around it.
- **B — Kyverno audit-first, then enforce per-policy.** Seeing
  violations in audit mode before they block anything turns the
  rollout into a conscious ratchet. (Scoped to Wave 2 implementation.)
- **B — NetworkPolicy allow-first baseline, then targeted deny.** Same
  rationale. Big-bang deny-all + allow-list in one PR breaks the
  cluster in subtle, hard-to-debug ways. (Scoped to Wave 2.)

### What shipped (Wave 1)

**OAuth sign-in replaces guest (commit 8452d70):**

- New GitHub OAuth App in the `kelechi-platform` org
  (`IDP Portal (Backstage) — local`), separate primitive from the
  Scaffolder GitHub App — OAuth Apps handle user identity, GitHub
  Apps handle machine identity.
- Client ID + secret seeded at Vault `secret/backstage/github-oauth`
  via the one-time bootstrap in
  `platform/backstage/rbac/externalsecret-github-oauth.yaml` header.
- ESO materialises `backstage-github-oauth` Secret with
  `GITHUB_OAUTH_CLIENT_ID` + `GITHUB_OAUTH_CLIENT_SECRET` keys.
- `platform/argocd/apps/backstage.yaml` Helm override + baked
  `portal/app-config.yaml`:
  - Added `auth.providers.github.development` block with env refs +
    `usernameMatchingUserEntityName` resolver
  - Removed `auth.legacyGuestToken: true`
  - Removed `backend.auth.dangerouslyDisableDefaultAuthPolicy: true`
  - Guest provider removed from appConfig.auth.providers
- `catalog/owners.yaml`: User renamed from `kaycee` to `kelechi-nwankpa`
  so the standard `usernameMatchingUserEntityName` resolver maps the
  OAuth-returned GitHub login directly to a catalog User entity — no
  custom resolver work.
- `templates/nodejs-fastify-svc/template.yaml`: owner ref updated to
  match the renamed User.
- `portal/packages/backend/src/index.ts`: `plugin-auth-backend-module-github-provider`
  wired. Guest provider kept registered (inert without a matching
  appConfig.auth.providers.guest) as emergency recovery.

**Frontend SignInPage override (commit 93c96c8):**

- `portal/packages/app/src/App.tsx`: explicit `SignInPageBlueprint`
  extension that renders a singular GitHub provider. Backstage 1.44+'s
  new frontend system ships a default SignInPage that shows Guest
  regardless of config; the explicit override is the only way to
  remove it.
- Wrapped in `createFrontendModule({ pluginId: 'app', extensions: [signInPage] })`
  — the registration shape SignInPageBlueprint extensions require.

**Scoped ArgoCD account (commits 9766147 + 27a693f + 9fbf3e5 + 20279cf + 544848d):**

- `platform/argocd/config/argocd-cm.yaml` (NEW): adds
  `accounts.backstage: apiKey` — local account with apiKey capability
  only, cannot UI-sign-in.
- `platform/argocd/config/argocd-rbac-cm.yaml` (NEW): custom
  `role:backstage-reader` with ONLY `applications, get+list, */*`
  plus `projects, get, *` (the projects grant surfaced after the
  initial narrow `applications`-only policy — ArgoCD hides apps as
  404 when the caller can't see the parent project).
- `platform/argocd/apps/argocd-config.yaml` (NEW): ArgoCD Application
  syncing the config patches via ServerSideApply. GitOps for ArgoCD's
  own config.
- `platform/backstage/rbac/externalsecret-argocd.yaml`: adds
  `ARGOCD_AUTH_TOKEN` key alongside existing `ARGOCD_USERNAME` +
  `ARGOCD_PASSWORD` (rollback preserved during transition).
- `backstage.yaml` + `portal/app-config.yaml`: `argocd:` block swapped
  from `username/password` to `token: ${ARGOCD_AUTH_TOKEN}`.
- `argocd.localDevelopment: true` added to accept argocd-server's
  self-signed TLS cert on the backend plugin's undici fetch path.

**Backend plugin ecosystem wired (commits 9fbf3e5 + 544848d):**

- `@backstage-community/plugin-argocd-backend` 1.7.2 added to
  `portal/packages/backend/package.json` and registered in
  `backend/src/index.ts`. Without the backend companion, the frontend
  plugin's `/api/argocd/*` routes 404 regardless of how correctly the
  proxy, token, and RBAC are configured — a classic
  installed-but-not-wired trap.
- `@backstage/plugin-kubernetes/alpha` added to `createApp` features.
  The ArgoCD plugin transitively calls `apiRef{plugin.kubernetes.service}`
  on its Deployment tab; without the Kubernetes frontend plugin
  registered, the apiRef has no implementation and throws
  `NotImplementedError`.

**CVE suppressions (commit adffa3a):**

- `portal/.trivyignore`: 10 new CVEs (node-forge x7, follow-redirects
  x1, zlib1g x2) suppressed with REASON + MITIGATION comments. These
  surfaced after the Actions cache cold-start post repo-restore. 8W3
  CVE sweep is the proper fix via yarn resolutions + Chainguard base.

### End-to-end verified (idp-demo-02-style smoke test)

```text
1. Open http://localhost:7007
2. SignIn page shows ONE tile: "Sign in using GitHub" (no Guest)
3. Click -> OAuth redirect to github.com -> Authorize
4. Returned to Backstage with kelechi-nwankpa identity
5. Catalog loads 15 Components owned by platform-team
6. Click Create -> nodejs-fastify-svc template renders with author
    "Kelechi Nwankpa" at the bottom
7. Click into platform-hello Component -> Overview tab renders
8. Click Deployment tab -> ArgoCD state renders:
    Application: platform-hello
    Status: OutOfSync / Missing  (real ArgoCD state)
    Instance: kind-idp
    Cluster: https://kubernetes.default.svc (in-cluster)
    Namespace: platform-hello
    Revision: main
    Resources: 8 items with per-resource sync status
```

All data fetched via the scoped `backstage` account's apiKey token,
NOT the admin creds.

## Bugs banked (Phase 8 Wave 1)

Numbered so future sessions can grep.

### 1. GitHub Actions disabled on a restored repository

**Symptom:** After the Oct-29 accidental repo delete + GitHub restore,
`gh run list` returned no runs even though workflow files existed and
pushes landed. **Cause:** GitHub Actions requires an explicit re-enable
on restored repos (yellow banner in Settings → Actions). **Fix:** click
"Enable Actions on this repository" in the Actions tab's banner. Also
added `workflow_dispatch: {}` trigger to `portal-ci.yml` (commit e93b777)
so future repo restores have a manual escape hatch. **Non-obvious
lesson:** repo restore is not fully-transparent — Actions/registrations
need manual re-enable.

### 2. Backstage 1.44 new frontend system ships a Guest SignInPage by default

**Symptom:** After removing `legacyGuestToken` + `guest: {}` from
appConfig.auth.providers, the sign-in page STILL showed "Guest" as the
only option. **Cause:** `@backstage/frontend-defaults` ships a default
SignInPage extension that renders Guest regardless of config — not
controllable via YAML alone. **Fix:** explicit `SignInPageBlueprint`
extension in `App.tsx` with singular `provider={githubAuthApiRef}`,
wrapped in `createFrontendModule({ pluginId: 'app' })`. **Non-obvious
lesson:** for Backstage 1.44+ removing a sign-in option is a code change,
not a config change.

### 3. ArgoCD narrow RBAC without projects:get silently hides apps as 404

**Symptom:** Scoped backstage account had
`p, role:backstage-reader, applications, get+list, */*, allow`. Direct
`GET /api/v1/applications/platform-hello` returned 200. But the plugin's
search endpoint `/api/v1/applications?name=platform-hello` returned
empty + eventually 404. **Cause:** ArgoCD's search filters results by
what the caller can see in the parent project. Without
`projects, get, *` the search path hides apps. **Fix:** add `p,
role:backstage-reader, projects, get, *, allow` to the policy (still
narrower than built-in `role:readonly` which grants reads on
clusters, repositories, gpgkeys too). **Non-obvious lesson:** ArgoCD
RBAC narrowing has two layers (resource grant + project visibility);
missing either hides data silently.

### 4. ArgoCD plugin frontend route 404 — backend plugin missing

**Symptom:** After RBAC + token fixes, Component Deployment tab logs
showed repeated `GET /api/argocd/find/name/platform-hello 404`. The
plugin wasn't even trying to call ArgoCD at that point. **Cause:**
`@backstage-community/plugin-argocd` ships in multiple packages;
`-backend` was never installed. The frontend hits a BACKSTAGE route
`/api/argocd/*` that doesn't exist without the backend plugin.
**Fix:** `yarn workspace backend add @backstage-community/plugin-argocd-backend`
and `backend.add(import('...'))` in `backend/src/index.ts`. **Non-obvious
lesson:** "the plugin is installed" in package.json means nothing in
the new backend system until a plugin is also `backend.add()`ed; and
frontend plugins often have backend companions that must be installed
separately.

### 5. ArgoCD backend plugin rejects self-signed in-cluster cert

**Symptom:** After adding the backend plugin, error shifted from 404
to 500 "fetch failed". Pod logs showed
`Request failed with status 500 Failed to retrieve ArgoCD Applications
from Instance 'kind-idp' ... : fetch failed`. **Cause:** The backend
plugin's undici fetch() rejects the argocd-server self-signed TLS cert
by default. The appConfig proxy block's `secure: false` doesn't apply
— backend plugin bypasses the proxy. **Fix:** `argocd.localDevelopment:
true` in appConfig. The plugin reads this flag + uses a custom
`undici.Agent` with `rejectUnauthorized=false`. **Non-obvious lesson:**
each plugin may have its own TLS-trust escape hatch; proxy settings
don't propagate to direct-fetch plugin paths. Phase 9 EKS swaps this
for a real trust bundle.

### 6. ArgoCD plugin transitively requires Kubernetes frontend

**Symptom:** After TLS fix, UI error became
`NotImplementedError: No implementation available for
apiRef{plugin.kubernetes.service}`. **Cause:** The ArgoCD plugin's
Deployment tab transitively calls `plugin.kubernetes.service` apiRef
for its resource-rendering path. That apiRef is provided by
`@backstage/plugin-kubernetes` frontend, which was in `packages/app/package.json`
since Phase 5 Wave 2 but never registered in `createApp` features.
**Fix:** `import kubernetesPlugin from '@backstage/plugin-kubernetes/alpha'`
and add to features. **Non-obvious lesson:** Backstage frontend plugins
can declare peer-plugin requirements via apiRefs but can't enforce
them at build time; missing registrations surface as cryptic
`NotImplementedError` at runtime.

### 7. Portal CI build time jumped to 25-30 min on cold Actions cache

**Symptom:** First few Portal CI runs post repo-restore took 25-30 min
each (vs 5-8 min with warm cache). **Cause:** GitHub Actions cache was
empty after repo restore; multi-arch QEMU-emulated arm64 builds +
1511-package yarn install both benefit heavily from cache. **Mitigation:**
no code change — subsequent runs with cache dropped back to 8-12 min.
**Non-obvious lesson:** budget for cold cache after any repo restore
or cache purge; don't try to "fix" the long duration.

### 8. Vault PV data persisted across Wave 3 PVC delete — repeat

**Not actually Phase 8**, but a re-mention worth noting: during the
repo-delete recovery we did NOT need to reset Vault. This time the
earlier Wave 3 Vault reset recipe stood up correctly — Vault was
unsealed, ESO was syncing, no credential drama. Pattern confirmed:
dump live ESO Secrets → reset Vault → re-seed from dump. See
`phase-5-backstage.md` Wave 3 close-out for the full recipe.

## Loose ends for Phase 10 polish

- **Root `/` 404** — the SignInPage extension and the baked
  `app.extensions: - page:catalog: config.path: /` override step on
  each other over who owns `/`. Nav links work; clicking the
  Backstage logo at root returns 404. Cosmetic.
- **ArgoCD Deployment tab OutOfSync state on platform-hello** — real
  ArgoCD state (pre-existing from before the auth work); unrelated
  to Wave 1. Investigate in platform-hello's own session.
- **Phase 10 ingestor for auto-discovery of Crossplane resources** —
  continues from Wave 3 close-out; same kubernetes-ingestor package
  solves it.

## Business value delivered (Wave 1)

**Four concrete security wins:**

- Removed both `dangerously*` and `legacy*` auth flags — the two
  specific items the Wave 3 close-out listed as the biggest debts.
- Backstage sign-in now produces real per-user service tokens that
  satisfy Backstage 1.44+'s strict default auth policy. Every
  `/api/catalog/*` call carries proof of identity.
- ArgoCD admin credentials no longer baked into Backstage runtime.
  The `backstage` apiKey token has get+list on Applications and get
  on Projects — **no other resource, no other verb**. If the token
  leaks, an attacker can list apps but not sync, delete, or modify.
- Backstage frontend plugin ecosystem (ArgoCD + Kubernetes + their
  backend companions) correctly wired. The plugin UI tells the truth
  about cluster state — real auth propagating through 7 layers of
  Backstage machinery (SignIn → identity → frontend plugin → backend
  plugin → undici → token → RBAC → ArgoCD).

## Interview talking points (Wave 1)

1. *"I replaced Backstage's two dev-mode auth escape hatches with GitHub
    OAuth + a scoped ArgoCD service account. The whole auth chain now
    propagates real identity — from the OAuth sign-in through service
    tokens to API calls, with per-user RBAC at the destination."*
2. *"I debugged 7 layers of Backstage plugin ecosystem to prove the
    Deployment tab renders real ArgoCD state via a scoped token. Each
    layer had its own failure mode: TLS cert rejection in the backend
    plugin, RBAC that filters silently, apiRef implementations missing
    from the frontend. The surface area of 'what can go wrong' in a
    plugin-based auth path is bigger than it looks."*
3. *"I narrowed the ArgoCD read account from built-in `role:readonly`
    to a custom `role:backstage-reader` with just two resources.
    Narrower RBAC means a smaller blast radius if the token leaks."*
4. *"I separated GitHub Apps (machine identity, installation-scoped)
    from GitHub OAuth Apps (user identity, OAuth flow). Backstage needs
    both — the Scaffolder uses the App for repo creation, sign-in uses
    the OAuth App. They look similar but serve fundamentally different
    use cases."*

## Recruiter Q&A (Wave 1)

- *"How does a developer prove who they are to your IDP?"* — They
  sign in with their GitHub account. Backstage runs the OAuth flow
  against our GitHub OAuth App, receives their GitHub identity, and
  resolves them against a catalog User entity whose metadata.name
  matches their GitHub login. Every subsequent API call carries a
  per-user Backstage service token that the backend validates.
- *"What identity does the IDP use to talk to its own ArgoCD?"* — A
  dedicated ArgoCD local account called `backstage` with the `apiKey`
  capability only — it can mint API tokens but cannot sign in to the
  ArgoCD UI as a human. Its RBAC is custom, read-only on Applications
  and Projects. If the token leaks it can see what's deployed but can't
  modify anything.
- *"What was the tradeoff of making this a separate wave vs
  Phase 5?"* — Phase 5 shipped the click-to-create demo, which was
  the business-value headline. Shipping it with the dev-mode flags
  was a conscious trade: "ship the demo, bank the debt, pay it in a
  dedicated wave." Phase 8 Wave 1 is that dedicated wave.
- *"What's next after auth?"* — 8W2 adds policy enforcement (Kyverno
  with NetworkPolicy and PSS) so the cluster gates its own worst habits
  at admission time. 8W3 is a supply-chain + CVE sweep. 8W4 is
  housekeeping.

## LinkedIn post idea (Wave 1)

> *"Just closed Phase 8 Wave 1 on the IDP — removed the two dev-mode
> auth escape hatches Backstage shipped with by default, and replaced
> ArgoCD admin credentials with a scoped read-only service account.
> Took 7 layers of Backstage plugin ecosystem debugging to prove the
> whole chain works end-to-end (TLS cert escape hatch in the undici
> fetch, narrow RBAC that hides apps as 404 until you grant projects:get,
> a `NotImplementedError` because one of the plugin's peer apiRefs
> isn't registered…). The real lesson: in a plugin-based platform,
> "the plugin is installed" and "the plugin is wired" are different
> things, and the second one is where most of the work hides. 🧵"*

Thread with:

- Screenshot of the sign-in page (one GitHub tile, no Guest)
- Screenshot of the Deployment tab rendering real state
- The 7-layer chain diagram from the close-out
- The RBAC narrowing policy
- The one-line config flag (`localDevelopment: true`) that unlocked
  the TLS path

## YouTube video idea (Wave 1)

**Title:** *"7 layers deep: hardening auth in an internal developer
platform (Backstage + ArgoCD + GitOps)"*

**Hook (first 10s):** split-screen showing the before/after Backstage
sign-in page (Guest vs GitHub-only) with the ArgoCD Deployment tab
rendering OutOfSync state in the background.

**Chapters:**

1. The two "dangerously" flags Wave 3 banked — what they did
2. GitHub OAuth App vs GitHub App — why Backstage needs both
3. Rename the catalog User to match the GitHub login — one-line
    resolver trick
4. The SignInPage override — why YAML isn't enough in the new frontend
    system
5. ArgoCD local accounts + apiKey + narrow RBAC
6. The 7-layer debug trail (404 → 500 → NotImplementedError)
7. What's next (Kyverno + NetworkPolicy — Wave 2 preview)

## Next in project (post-Wave 1)

**Immediate options:**

1. **8W2 — Policy enforcement.** Kyverno (audit → enforce) + NetworkPolicy
    (allow-first baseline → targeted deny) + Pod Security Standards
    labels. Natural continuation. ~2 sessions.
2. **8W3 — Supply chain + CVE sweep.** Chainguard base images + GitHub
    Actions SHA pins + Backstage CVE remediation via yarn resolutions.
    ~1-2 sessions.
3. **Loose-end sprint.** Root `/` 404 fix + platform-hello ArgoCD
    OutOfSync investigation + any benign drift cleanup. ~0.5 session.

**Session opener for 8W2:** *"start 8W2, Kyverno and NetworkPolicy"*.

## See also (Wave 1)

- [portal/packages/app/src/App.tsx](../../portal/packages/app/src/App.tsx)
  — final createApp features array (catalog + scaffolder +
  notifications + kubernetes + argocd + crossplane + nav + home +
  SignInPage override)
- [portal/packages/backend/src/index.ts](../../portal/packages/backend/src/index.ts)
  — backend.add calls for github-provider + argocd-backend +
  crossplane-permissions-backend
- [platform/argocd/config/argocd-cm.yaml](../../platform/argocd/config/argocd-cm.yaml)
  — the local-account ConfigMap patch
- [platform/argocd/config/argocd-rbac-cm.yaml](../../platform/argocd/config/argocd-rbac-cm.yaml)
  — the narrow role:backstage-reader policy
- [platform/argocd/apps/argocd-config.yaml](../../platform/argocd/apps/argocd-config.yaml)
  — the ArgoCD Application that GitOps's ArgoCD's own config
- [platform/backstage/rbac/externalsecret-github-oauth.yaml](../../platform/backstage/rbac/externalsecret-github-oauth.yaml)
  — ESO ExternalSecret for OAuth creds
- [platform/backstage/rbac/externalsecret-argocd.yaml](../../platform/backstage/rbac/externalsecret-argocd.yaml)
  — ESO ExternalSecret for the scoped ArgoCD token
- Phase 5 Wave 3 close-out in [phase-5-backstage.md](phase-5-backstage.md)
  — the original debt log Wave 1 closes

## Phase 8 Wave 2 — Policy enforcement (Kyverno + NetworkPolicy + PSS)

**Status:** ✅ Shipped 2026-11-19 (single session, ~3 hours).

**Primary deliverable:** The cluster refuses workloads that violate
platform policies at admission time, pods in the backstage namespace
can only talk to known-good destinations, and three key namespaces
carry explicit Pod Security Standards profiles. The "code review
discipline" security story becomes "the cluster enforces it."

### Design decisions locked in (user-confirmed A/C/B/B at phase open)

- **A — Official kyverno/kyverno Helm chart.** Matches our ESO +
  cert-manager + ArgoCD install pattern. GitOps-friendly, security
  patches track upstream.
- **C — Policies cherry-picked from Kyverno's policy library into
  our Git.** Proven policies, reviewable per-file, clearer audit
  trail than wholesale import.
- **B — Namespace exemptions per policy** for kube-system, kyverno,
  local-path-storage (the "upstream distribution" layer).
- **B — Case-by-case PSS profiles** (`restricted` where it works,
  `baseline` where restricted breaks something).

### What shipped (Wave 2)

**Kyverno engine (commit a05ebe8):**

- Official chart 3.5.1 via new ArgoCD Application
  [`platform/argocd/apps/kyverno.yaml`](../../platform/argocd/apps/kyverno.yaml).
- 4 controllers (admission + background + reports + cleanup) each
  with explicit resources so Kyverno itself passes the
  `require-resources` policy we were about to ship.
- `serviceMonitor.enabled: true` on each controller — same
  Prometheus-scraping pattern as ESO + cert-manager (ADR-0025).
- `features.imageVerify: false` — cosign admission-time verification
  deferred to Phase 10 polish; cosign IS wired in Phase 7 CI, this
  is defence-in-depth not debt.

**5 ClusterPolicies (commit 5ba012a, promotions a1768df):**

- `disallow-latest` → **Enforce** (zero violations in audit)
- `disallow-host-namespaces` → **Enforce** (6 violations, all
  monitoring/node-exporter; added monitoring namespace to the
  exemption list)
- `require-non-root` → **Audit** (18 violations, needs per-case review)
- `require-resources` → **Audit** (80 violations across upstream charts)
- `require-labels` → **Audit** (86 violations across upstream charts)

Each policy lives in its own file under
[`platform/kyverno/policies/`](../../platform/kyverno/policies/).
Policy-by-policy promotion matches design decision "B — audit-first,
then enforce per-policy" — we did NOT big-bang promote all 5.

**NetworkPolicy baselines (commit 08df1ce):**

- Explicit allow-all NetworkPolicy baselines for backstage, argocd,
  and observability namespaces under
  [`platform/network-policies/`](../../platform/network-policies/).
- GitOps-managed by new ArgoCD Application
  [`platform/argocd/apps/network-policies.yaml`](../../platform/argocd/apps/network-policies.yaml).
- Behavior unchanged (allow-all = no policy), but the stance is
  declared in Git + Git-blameable.

**Backstage narrowed to deny-default (commit e3bb97f):**

- Replaced `backstage-allow-all.yaml` with:
  - 7 targeted-allow policies (DNS, Postgres, Vault, ArgoCD,
    kube-apiserver, internet, ingress on 7007)
  - 1 deny-default policy that catches anything not explicitly
    allowed
- Verified post-flip: Backstage pod kept running, no restart, all
  plugin backends (K8s, ArgoCD) still responding.

**Pod Security Standards (commit a439945):**

- backstage: `restricted` (via
  `syncPolicy.managedNamespaceMetadata` on the Backstage Application —
  no need for a separate Namespace manifest).
- argocd: `baseline` (via `platform/namespaces/argocd.yaml` +
  new `namespaces` ArgoCD Application + SSA).
- observability: `baseline` (same pattern).
- All three sticker-levels (`enforce` + `audit` + `warn`) set to
  the same profile per namespace for consistent signalling.

### Bugs banked (Wave 2)

Numbered so future sessions can grep. Fewer bugs than Wave 1 — the
policy-enforcement surface is more declarative + less plumbing.

#### 1. Audit review found 80+ violations across upstream charts

**Symptom:** After shipping 5 ClusterPolicies in Audit mode, the
PolicyReport scanner showed 190 total failures across the cluster.
**Cause:** `require-labels`, `require-resources`, and `require-non-root`
all flag pods in third-party charts (Backstage's Postgres sub-chart,
ArgoCD's redis/dex, Prometheus exporters). **Not actually a bug** —
the audit mode is doing exactly what it should (surfacing real gaps).
**Fix:** promoted ONLY the two policies with zero or small-scope
violations (`disallow-latest`, `disallow-host-namespaces` with a
monitoring exemption). The other 3 stay in Audit until Phase 10
polish adds per-chart values customization to fix the upstream gaps.
**Non-obvious lesson:** policy-by-policy promotion is the right
unit, not the "five policies all go to Enforce" unit. Each policy
has its own violations surface + its own promotion decision.

#### 2. Ratchet order for NetworkPolicy narrowing matters

**Symptom:** Nothing surfaced because we got it right. **Cause-that-
would-have-surfaced:** if we had shipped `backstage-deny-default.yaml`
BEFORE the 7 targeted-allow policies (or in the same commit but
alphabetically evaluated first), there would be a window where the
Backstage pod loses all connectivity. **How we avoided it:** the
commit put both in the same patch; ArgoCD applies the file set
atomically via Server-Side Apply. **Non-obvious lesson:** NetworkPolicy
rollouts have an "order of application matters" trap. Mitigation:
ship allows + deny in the same commit, or ship allows first in one
commit + deny-default in a second. Never deny alone.

#### 3. PSS labels via ArgoCD — managedNamespaceMetadata vs separate Application

**Symptom:** The first attempt tried to patch namespace labels via a
new Application that targeted namespaces created by OTHER Applications
with `CreateNamespace=true`. ArgoCD normally rejects this as resource
ownership conflict. **Cause:** `CreateNamespace=true` makes the
creator Application own the Namespace resource; another Application
can't manage the same resource. **Fix:** two mechanisms depending
on whether the Application creator ALREADY has `managedNamespaceMetadata`
support:

- Backstage Application: added `syncPolicy.managedNamespaceMetadata.labels`
  directly to the existing Application (clean, zero new Applications).
- Other namespaces (argocd, observability): new `namespaces`
  ArgoCD Application + Namespace manifests + Server-Side Apply.
  SSA's field-manager tracking means the labels merge onto the
  existing namespace without claiming ownership of fields the
  original creator set.

**Non-obvious lesson:** ArgoCD's conflict detection is about
field-manager ownership, not resource existence. Patch-style
modifications with SSA are compatible with other Applications
managing the same resource — as long as they touch orthogonal fields.

### Business value delivered (Wave 2)

**Three concrete platform wins:**

- **Admission-time enforcement.** `:latest` tags + hostNetwork can't
  be shipped by accident anymore — the cluster rejects at kube-apiserver
  before the pod schedules. Code review discipline stops being
  the sole defence.
- **Network isolation on the user-facing workload.** Backstage's
  outbound surface is 6 specific destinations (DNS, Postgres, Vault,
  ArgoCD, kube-apiserver, internet) instead of "anything the pod
  decides to connect to." Compromise blast radius drops by ~90%.
- **Explicit PSS profiles on 3 namespaces.** The cluster doesn't
  just rely on "we built the images carefully"; it enforces
  non-root + no-privileged + restricted sysctls at admission.

**Pattern established** for Phase 10 polish rollout to the other
6 platform namespaces (same mechanical repetition; same
`platform/network-policies/` and `platform/namespaces/` dirs).

### Interview talking points (Wave 2)

1. *"I shipped Kyverno as the platform's admission controller — five
    ClusterPolicies covering the baseline hardening set
    (no `:latest`, resource limits required, non-root, no hostPath/hostNetwork,
    required labels). All five started in Audit mode so I could inventory
    real-world violations before anything blocked. Then promoted
    policy-by-policy to Enforce based on what the audit reports showed."*
2. *"I narrowed the Backstage namespace's network surface from
    'anything' to 6 specific destinations — DNS, Postgres, Vault,
    ArgoCD, kube-apiserver, and internet for GitHub OAuth. Did it
    via the 'allows first, deny-default last' ratchet so there was
    never a window where Backstage lost connectivity."*
3. *"I applied Pod Security Standards in two different ways depending
    on whether the ArgoCD Application that created the namespace had
    `managedNamespaceMetadata` support — that field gives you clean
    label management without creating a second Application. For
    namespaces where that wasn't available, I used Server-Side Apply
    to merge label patches onto existing namespaces without
    ownership conflicts."*
4. *"The audit-first strategy surfaced 190 violations across upstream
    charts. 2 policies were safe to promote to Enforce immediately
    (`:latest`, hostNetwork). 3 revealed real gaps in upstream chart
    configurations that need per-chart customization — explicitly
    flagged as Phase 10 polish rather than papered over."*

### Recruiter Q&A (Wave 2)

- *"What stops a developer from shipping an insecure pod?"* — Kyverno
  rejects it at admission time. The rejection happens BEFORE the
  pod schedules, so the developer sees an immediate `kubectl apply`
  error explaining what rule they violated. No "the pod ran for 3
  hours and then OOMed" surprises.
- *"How do you prevent a compromised Backstage pod from calling
  arbitrary cluster endpoints?"* — NetworkPolicy. Backstage can only
  reach 6 specific destinations I've whitelisted. If someone
  compromised the image, they'd find the pod can't connect to
  anything else.
- *"Why ship policies in Audit mode first instead of just enforcing?"* —
  Enforcing without knowing what violates would break the cluster
  on the next pod restart. Audit mode showed me exactly which
  workloads violated each policy; I promoted policies to Enforce
  only after confirming the cluster is already compliant (or after
  adding targeted exemptions).

### Loose ends for Phase 10 polish

- **3 ClusterPolicies in Audit mode** — require-non-root,
  require-resources, require-labels. Need per-chart fixes to upstream
  Helm values before promotion.
- **5 platform namespaces lack PSS labels** — kyverno, cert-manager,
  external-secrets, vault, monitoring, external-dns. Mechanical
  rollout of the pattern established here.
- **2 namespaces at allow-all NetworkPolicy baseline** — argocd,
  observability. Narrowing waits on a traffic inventory pass that's
  more work than backstage's (ArgoCD talks to every namespace it
  syncs; observability receives from every workload).

### Phase 8 Wave 3 roadmap (what Wave 2 explicitly leaves for Wave 3)

1. Swap `node:22-trixie-slim` for a Chainguard distroless Node base
    in `portal/Dockerfile`.
2. Pin every GitHub Actions `uses:` to a commit SHA (not a tag).
3. Add yarn resolutions for the high-volume CVE packages
    (`node-forge`, `follow-redirects`, `undici`). Drops Trivy
    suppression count from 45 → ~5.
4. Re-scan with Trivy; remove `.trivyignore` entries that are
    now actually fixed upstream.

**Est: 1-2 sessions.** Session opener:
*"start 8W3, Chainguard + action SHA pins + CVE sweep."*

### See also (Wave 2)

- [platform/argocd/apps/kyverno.yaml](../../platform/argocd/apps/kyverno.yaml)
  — Kyverno engine install
- [platform/argocd/apps/kyverno-policies.yaml](../../platform/argocd/apps/kyverno-policies.yaml)
  — syncs the policies dir
- [platform/kyverno/policies/](../../platform/kyverno/policies/)
  — the 5 ClusterPolicies
- [platform/argocd/apps/network-policies.yaml](../../platform/argocd/apps/network-policies.yaml)
  — syncs the network-policies dir
- [platform/network-policies/](../../platform/network-policies/)
  — allow-all baselines + Backstage's narrowed set
- [platform/argocd/apps/namespaces.yaml](../../platform/argocd/apps/namespaces.yaml)
  — syncs namespace label patches
- [platform/namespaces/](../../platform/namespaces/) — PSS label patches

---

## Phase 8 Wave 3 — Supply chain hardening (base image + CVE sweep + pinned CI)

**Status:** ✅ Shipped 2026-11-19 → 2026-11-20 (two sessions; one
long root-causing arc on the base image, one fast sweep).

**Primary deliverable:** The Backstage image is built on a
minimal, CVE-tracked distro, runs as a non-root user under PSS
`restricted`, ships with every fixable dependency CVE actually
fixed (not suppressed), and is produced by a CI pipeline whose
third-party code is pinned to immutable commits and kept fresh by
Dependabot.

### Design decisions locked in (user-confirmed A/A/A at wave open)

- **A — Chainguard/Wolfi base for the portal image.** Replaces
  Debian `node:22-trixie-slim`. Minimal package set, rebuilt on
  upstream CVE fixes. *Outcome deviated in a documented way:* the
  `chainguard/node` image was abandoned for `wolfi-base` + `apk add
  nodejs-24` (see bugs 3 and 5 for why).
- **A — Fix transitives in place, not by suppression.** `yarn up -R`
  where the fix is inside the requested range, scoped `resolutions`
  only where it isn't. `.trivyignore` keeps only CVEs with no fix
  reachable without a major-version jump or a framework upgrade.
- **A — SHA-pin every third-party Action + Dependabot to keep pins
  fresh.** Pinning without automated bumps would trade supply-chain
  risk for staleness risk.

### What shipped (Wave 3)

**Base image: Wolfi + Node 24, non-root (8W3.2, commits b47de81 →
a9adcf7, deployed 4d354fe):**

- All three Dockerfile stages `FROM cgr.dev/chainguard/wolfi-base`;
  Node from the free Wolfi apk index (`nodejs-24` 24.22.3-r2,
  scanned clean).
- Runtime stage runs as Wolfi's `nonroot` (uid/gid 65532) with
  `--chown` on every COPY.
- tree-sitter native builds skipped via `dependenciesMeta.built:
  false` in [portal/package.json](../../portal/package.json); the
  apidom parsers use their web-tree-sitter (WASM) build instead.
- Backstage Deployment gained a PSS-restricted-compliant
  `securityContext` (6ec11db) and explicit resources (e61fc09)
  *before* the image roll.

**Native per-arch CI runners (977d322):**

- The reusable workflow builds `linux/amd64` on `ubuntu-latest` and
  `linux/arm64` on `ubuntu-24.04-arm` natively, pushes each by
  digest, then stitches the multi-arch manifest in a `merge` job
  with `docker buildx imagetools create`. cosign signs the merged
  digest. QEMU is gone.
- Inherited automatically by every service on the golden path
  (platform-hello's next push is the first downstream exercise).

**CVE sweep (8W3.3, commits 867c454 + ae5593c):**

- In-range bumps: node-forge 1.4.3, follow-redirects 1.16.3,
  undici 7.30.2 / 8.12.4, markdown-it 14.3.3, body-parser
  1.20.9 / 2.4.0, multer 2.5.0.
- Scoped `resolutions`: `undici@npm:7.29.0` (exact pin in
  `@module-federation/dts-plugin`), `@yarnpkg/core/got` (bug 10),
  `@types/react(-dom): ^18` (bug 11).
- `node-gyp` 10 → 13 in root + backend workspaces. That deleted the
  vulnerable `cacache@18 → tar@6.2.1` subtree from the lockfile
  outright (bug 12).

**.trivyignore pruned 45 → 11 entries (dd5a74b):**

- 34 entries removed, every one verified absent by a fresh scan.
  (The dd5a74b commit message says "29"; it was written before the
  second sweep pass and miscounted. The verified figure is 34.)
- Survivors fall into exactly two buckets, documented in the file
  header: (1) major-jump transitives under the old
  `@backstage/backend-defaults@0.12.3` copy (undici 5.x ×5,
  urllib@3), and (2) fixes needing the Backstage framework bump.
- Stale mitigation text ("auth=guest") rewritten to match the
  post-Wave-1 GitHub OAuth posture.

**SHA-pinned Actions (8W3.4, 3cae025):** 12 third-party actions
pinned as `@<sha> # vX.Y.Z` across both workflow files. Same-repo
reusable-workflow references deliberately left on refs (no trust
boundary crossed).

**Dependabot extended (8W3.5, b3c861e):** the Phase 0
github-actions-only config gained an npm ecosystem for `/portal`
(weekly, minor+patch grouped, `@backstage/*` ignored because the
framework moves as one line via `backstage-cli versions:bump`). 3
PRs opened within minutes of the push.

**api-docs plugin wired (be4082f):** found during the 8W3.2 smoke
test. API entities now have a Definition tab and the nav has an
"APIs" entry.

### End-to-end verified

- Pod `backstage-85cd79498-52tpb` on `sha-ae5593c`: uid 65532
  (`nonroot`), Node v24.22.3, admitted under PSS `restricted`, zero
  error-level logs.
- CI run 44572677753: both native arch builds, Trivy (image scan
  against the pruned ignore file), merge, cosign all green.
- `object-bucket-xrd` → Definition tab renders the OpenAPI spec.
  That page exercises the api-docs wiring and the apidom WASM
  parser path together.
- platform-hello Deployment tab still renders live ArgoCD state
  through the scoped `backstage` account.

### Bugs banked (Wave 3)

Numbered so future sessions can grep. The base-image arc (bugs 1–6)
took six CI iterations. Most of that cost came from fixing symptoms
before reproducing locally. Iteration 5 onward reproduced first,
and each of those iterations found its cause.

#### 1. `chainguard/node:latest-dev` defaults to a non-root user

**Symptom:** iteration 2 failed `yarn install` with EACCES on
`mkdir node_modules`. Iteration 3 failed `apk add` with "Permission
denied". **Cause:** unlike Debian `node` images (root by default),
Chainguard's node image sets `USER node` (65532). COPY always
writes `root:root` regardless of USER, so the non-root user couldn't
write into its own build dir, and also couldn't install packages.
The second failure came from "fixing" the first by removing an
explicit USER line, on the assumption that the default was root.
**Fix:** at the time, `--chown` + explicit `USER root` for apk
(9f4715e, 2abb6c7); superseded by `wolfi-base`, which defaults to
root. **Lesson:** check the image's default USER (`docker inspect
--format '{{.Config.User}}'`) before writing a Dockerfile against
it. Don't infer it from another distro's convention.

#### 2. `g++` is not a Wolfi package

**Symptom:** iteration 1 `apk add g++` → package not found.
**Fix:** `build-base` (Wolfi's gcc/g++/make meta-package, 9a03924).
**Lesson:** package names are distro vocabulary, not universal.

#### 3. Chainguard's free tier publishes only `latest`, which is Node 26

**Symptom:** iteration 4: permissions fixed, but native modules
(tree-sitter, cpu-features, tree-sitter-json) failed to compile.
**Cause (found by local repro, not CI log reading):** `latest-dev`
shipped **Node v26.13.1**, outside Backstage's `engines` range
("22 || 24"). Version-pinned tags (`node:22-dev`) return
`MANIFEST_UNKNOWN` on free pulls, because they are a paid-tier
feature. **Fix:** `wolfi-base` + `apk add nodejs-22` (bd4b342),
which gets versioned Node from the free package index rather than
from a versioned image. **Lesson:** "free distroless image" and
"pinnable distroless image" can be different products. Check
whether you can pin before you adopt.

#### 4. QEMU user-mode emulation breaks heavy node-gyp compiles

**Symptom:** iteration 5: amd64 build green end-to-end; arm64
failed on the same native modules. **Cause:** a local native arm64
build (Apple Silicon) succeeded, which isolated the failure to the
CI runner's QEMU emulation rather than to the code or the arch.
**Fix:** native `ubuntu-24.04-arm` runners + push-by-digest + manifest
merge (977d322). Also cut build time, since emulated compiles are
5–10× slower. **Lesson:** when only the emulated arch fails, test the
same arch natively before touching the code.

#### 5. Wolfi's free index doesn't carry CVE patches for older Node streams

**Symptom:** Trivy: 3 HIGH on `nodejs-22` 22.23.2-r1. **First
hypothesis, wrong:** stale apk cache. `apk upgrade` was added
(e801b9a) and a clean rebuild still installed 22.23.2-r1.
**Actual cause:** the patched 22.23.4+ builds exist only in the paid
catalog. The free index receives CVE rebuilds only for current
streams. `nodejs-24` (24.22.3-r2) scanned with zero findings.
**Fix:** `nodejs-24` (a9adcf7), which is still inside Backstage's
engines range. **Lesson:** a clean rebuild that reproduces the same
version falsifies the stale-cache theory. Stop there and look at
what the index actually contains.

#### 6. tree-sitter@0.21.1 doesn't compile against Node 24's V8

**Symptom:** after the Node 24 switch, tree-sitter's native build
failed (`ConditionalStackAllocatedBase`). cpu-features and
better-sqlite3 compiled fine (verified locally). **Cause:**
apidom's parser adapters exact-pin tree-sitter 0.21.1, whose C++
predates Node 24's V8 API. **Fix:** `dependenciesMeta.<pkg>.built:
false` for tree-sitter, tree-sitter-json, and tree-sitter-yaml
(a9adcf7). **Why it's safe (proven later):** `yarn why -R
tree-sitter` shows the *only* path is `app → plugin-api-docs →
swagger-ui-react → swagger-client → apidom`. That is frontend code
running in the browser, where native Node bindings can never load
and web-tree-sitter (WASM) is always used. The Definition tab
rendering confirms it. **Lesson:** before skipping a native build,
trace who imports it. If no Node code path reaches it, the skip has
no effect at runtime.

#### 7. PSS `restricted` label landed before the pod was re-admitted

**Symptom:** none, because it was predicted and defused. **Cause that
would have surfaced:** Wave 2 labelled `backstage` as `restricted`,
but PSS evaluates only at admission. The running pod predated the
label, and its empty securityContext would have been *rejected* on
the next roll, which was this wave's image bump. **Fix:** shipped a
compliant securityContext (6ec11db) *before* the image bump. A
transient CrashLoop (old uid-1000 image forced to 65532) healed when
the Wolfi image arrived, as predicted. **Lesson:** admission-time
policies leave latent violations in running pods. Every label
change needs a "what happens on next roll?" check.

#### 8. Our own Kyverno audit flagged the Backstage Deployment

**Symptom:** `require-resources` PolicyReport failure on backstage
during the roll. **Fix:** explicit requests/limits (e61fc09).
**Lesson:** the Wave 2 audit policies earned their keep the first
time the platform team itself shipped a workload.

#### 9. api-docs plugin installed but never wired

**Symptom:** API entities had no Definition tab, on any image.
**Cause:** `@backstage/plugin-api-docs` was in `packages/app/package.json`
since the initial scaffold but absent from `createApp({ features })`.
**Fix:** import from `/alpha` + add to features (be4082f). **Lesson:**
this is the third instance of the same bug class (Wave 1 had
kubernetes + scaffolder). A useful audit: diff the plugin packages
in `package.json` against the `features` array.

#### 10. `yarn up` broke on `@yarnpkg/core`'s got patch

**Symptom:** `yarn up -R undici ...` → `ENOENT .yarn/patches/got-npm-11.8.2-*.patch`.
**Cause:** `@yarnpkg/core` (pulled in by `@backstage/cli`) publishes a
`patch:` descriptor that points at a file inside *Yarn's own*
monorepo, so it can't exist in a consumer repo. Any full
re-resolution trips it. **Fix:** `resolutions: "@yarnpkg/core/got":
"npm:^11.8.5"` (867c454). Dev tooling only, never in the runtime
image.

#### 11. `yarn up` re-resolved React types to 19

**Symptom:** `yarn tsc` failed in `node_modules/react-markdown`
(`Cannot find namespace 'JSX'`). **Bisect:** reverting the App.tsx
change didn't help, so the cause was the lockfile diff, which showed
`@types/react@*` jumping 18 → 19. **Cause:** an unpinned `*`
descriptor floated to React 19 types, splitting the tree into two
copies. **Fix:** `resolutions: @types/react(-dom): ^18`, the guard
that Backstage's own create-app scaffold ships and our app was
missing. **Lesson:** bisect before fixing; the obvious suspect (the
new import) was innocent.

#### 12. The lockfile scan is NOT a superset of the image scan

**Symptom:** a local `trivy fs` scan of yarn.lock showed 0 tar
findings. On that basis the 9 tar entries were pruned, and CI's
image scan then failed on those 9 CVEs at
`node_modules/{cacache,node-gyp}/node_modules/tar`. **Cause:**
Trivy's fs scanner excludes **devDependency subtrees** when
package.json sits beside the lockfile. node-gyp is a root devDep, so
its subtree was invisible locally. node-gyp is *also* a production
dependency of `packages/backend` (from the create-app scaffold), so
the subtree physically ships in the image, and the image scan walks
the disk without that exclusion. **Fix:** node-gyp 10 → 13 (ae5593c),
which removed the tar@6 subtree from the lockfile entirely instead
of re-ignoring 9 CVEs. **Lessons:** (a) the claim "my local scan is a
superset of CI's" had not been tested, and CI falsified it within
the hour; (b) the CI gate did its job, because a suppression was
caught before it reached a deployed image.

#### 13. Dependabot config overwritten without reading it

**Symptom:** the commit diff showed `16 deletions` on a file assumed
to be new. **Cause:** a Phase 0 `dependabot.yml` already existed.
**Fix:** caught from the diff stat before pushing; its
`commit-message: chore(deps)` convention was restored and the commit
amended. **Lesson:** a "new file" commit that deletes lines is a
signal to stop. Read the target before you write to it.

#### (Environment note, not a bug) kind egress flake after Mac sleep

A red "Unable to read url … fetch failed" banner on catalog entities
after the laptop woke from sleep. A 30× fetch probe from inside the
pod returned 100% success: the banner is the last failed attempt,
and it clears on the next refresh cycle. NetworkPolicy, UrlReader,
and image regression were all ruled out.

### Business value delivered (Wave 3)

- **CVE suppressions cut by three-quarters.** 45 → 11 ignored CVEs,
  with every survivor justified by "no fix without a major jump"
  rather than "we haven't got to it."
- **Smaller attack surface at runtime.** Wolfi minimal base, non-root
  65532, PSS `restricted`, no Debian package tail.
- **The CI supply chain can't be repointed by a third party.** Every
  third-party action runs a pinned commit. A compromised upstream
  tag (the tj-actions/changed-files class of incident, March 2025)
  can't inject code into our pipeline.
- **The pipeline stays current without manual work.** Dependabot
  opens grouped, reviewable PRs weekly, so pins and lockfiles don't
  drift for a month again.
- **Faster, more reliable multi-arch builds** for every service on the
  golden path, through the inherited native-runner workflow.

### Interview talking points (Wave 3)

1. *"I moved our developer portal to a Wolfi base and the first image
    choice turned out to be wrong for a reason I could only find by
    reproducing locally. Chainguard's free tier only publishes
    `latest`, which was Node 26, outside Backstage's supported range,
    and the pinnable tags are paid. I switched to `wolfi-base` and
    installed versioned Node from the package index, which keeps the
    minimal-distro benefits and lets us pin the major."*
2. *"Our arm64 build failed and amd64 passed. Rather than patch code,
    I built arm64 natively on my Mac and it passed, which pointed at
    QEMU emulation in CI. I moved the reusable workflow to native
    per-arch runners with digest-push and a manifest merge, and every
    service on the golden path inherited the fix."*
3. *"I treat `.trivyignore` as debt with an interest rate, not as a
    mute button. In this sweep I took it from 45 entries to 11, and
    the remaining 11 each have a written reason. I also learned the
    limits of my own tooling: a local lockfile scan hides devDependency
    subtrees, and CI's image scan caught a suppression I'd made on
    that basis within the hour. I fixed it by deleting the vulnerable
    subtree instead of re-ignoring it."*
4. *"Every third-party GitHub Action is SHA-pinned, and Dependabot
    bumps the SHA and its version comment together. Pinning alone
    would have frozen us out of the actions' own security fixes."*

### Recruiter Q&A (Wave 3)

- *"How do you handle vulnerabilities in open-source dependencies?"*
  Fix first and suppress last. Most CVEs are fixed by re-resolving
  within the version range the library already allows. When the fix
  sits outside that range, a scoped override works. Only CVEs with no
  reachable fix get suppressed, each with a written reason and a
  review date.
- *"Why pin GitHub Actions to commit hashes?"* A tag like `v4` can be
  moved by whoever controls the repo, including an attacker who
  compromises it. A commit hash can't be changed, so the code that
  runs in our pipeline is exactly the code we reviewed.
- *"What did you do when the fix kept failing?"* I stopped changing
  the Dockerfile and reproduced the build locally. The real cause,
  an unexpected Node major version in the base image, showed up in
  the first local run. CI logs had shown only the downstream symptom.

### Loose ends for Phase 10 polish

- **Backstage framework bump** (`backstage-cli versions:bump`). It
  retires the `backend-defaults@0.12.3` copy and with it 7 of the 11
  remaining ignored CVEs (undici 5.x ×5, urllib@3,
  backend-defaults itself).
- **Digest-pin `wolfi-base`** and add a Dependabot `docker` ecosystem
  entry for it. It currently floats on `latest`, the only free tag.
- **Full-distroless runtime stage.** Drop yarn from the runtime image
  by doing the production install in the builder.
- **Plugin wiring audit:** diff installed `@backstage*/plugin-*`
  packages against `createApp` features (bug 9 has now recurred
  three times).
- **Triage the 3 open Dependabot PRs.** Do this now as Wave 3
  aftercare rather than deferring it.

### See also (Wave 3)

- [portal/Dockerfile](../../portal/Dockerfile): the header carries
  the full base-image decision trail
- [portal/package.json](../../portal/package.json):
  `resolutions` + `dependenciesMeta`
- [portal/.trivyignore](../../portal/.trivyignore): the 11
  survivors and their two-bucket justification
- [.github/workflows/reusable-service-ci.yml](../../.github/workflows/reusable-service-ci.yml):
  native runners, digest merge, SHA pins
- [.github/dependabot.yml](../../.github/dependabot.yml)
