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
