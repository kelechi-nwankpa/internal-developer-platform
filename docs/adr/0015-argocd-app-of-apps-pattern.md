# 0015 — Use the ArgoCD app-of-apps pattern for platform bootstrap

- **Status:** Accepted
- **Date:** 2026-07-21
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

[ADR-0014](0014-argocd-raw-install-vs-helm.md) got ArgoCD onto the cluster. That answered *"how does ArgoCD get installed?"* The immediate next question is *"how does ArgoCD know what to install?"* — i.e., how do we declare the *set* of platform components ArgoCD should reconcile.

Every platform component from Phase 2 onward (cert-manager, ESO, ExternalDNS, AWS LBC, observability stack, Crossplane, Kyverno, Backstage) needs to be installed *by ArgoCD*, not by hand. Otherwise we've built a GitOps engine and immediately abandoned it — every install becomes a manual `kubectl apply`, and every drift becomes invisible.

We need to pick the declarative pattern by which platform components are added, removed, and reconciled.

## Decision drivers

1. **Zero manual `kubectl apply` after ArgoCD is bootstrapped.** The entire point of GitOps. If our chosen pattern requires periodic hand-applies, we've failed the sniff test.
2. **Every install/uninstall auditable in Git.** `git log` should be able to answer *"when did cert-manager arrive on the cluster, added by whom, in which PR?"* — no chat archaeology, no `kubectl get events`.
3. **Drift-correcting by default.** A manual `kubectl edit` against a managed resource must revert within minutes, not require human detection.
4. **Cheap to add a new component.** Adding cert-manager should be one file, one PR, one review — not a chart repo add, a values.yaml refactor, and three related PRs.
5. **Handles both hand-crafted and template-generated apps.** Phase 2 apps are five hand-crafted, dissimilar things. Phase 6 (Backstage golden paths) will generate many similar Applications from a template. The chosen pattern should coexist with a templating approach later, not conflict with it.
6. **Bootstrap survivable.** The pattern needs to be re-establishable in <5 minutes after a `make kind-down && make kind-up && make argocd-install`.

## Options considered

### Option A — Individual manual `kubectl apply` per Application

For each new component, hand-apply an `Application` YAML using `kubectl apply -f <file>` from a laptop.

- Pros: Simplest to reason about — each application is its own thing, no root, no recursion.
- Cons: Every install/uninstall/upgrade is a manual `kubectl apply`. Cluster state and Git state drift immediately. Requires humans to remember to apply changes. Defeats the point of installing ArgoCD in the first place. Zero audit story beyond `kubectl get events`.

### Option B — App-of-apps (chosen)

One `Application/root` object is applied manually **once**. It points at a Git directory (`platform/argocd/apps/`). Every file in that directory is another `Application` object. ArgoCD reconciles root, which reconciles the children, which reconcile their own managed resources.

- Pros: One manual apply, ever. Adding a component = pushing one file. Removing a component = deleting one file (with automatic prune). Every install/uninstall in `git log`. Drift-corrects via `selfHeal: true`. Independent apps have independent sync policies (any child can pin to a specific tag, use a different sync strategy, target a different namespace, etc.). Zero coupling between children. Matches the shape of Phase 2 work (~5 hand-crafted apps).
- Cons: Recursive mental model takes ~30 seconds to grok the first time. The single manual `apply` of root-app is a "how did this get here?" question in the runbook — but only once, and it's in a Makefile target and an ADR. Requires understanding that root-app itself is not GitOps-managed (though we could add a self-referential Application to close that loop; see "Consequences").

### Option C — ApplicationSet

A single `ApplicationSet` object with a template. Generators (list, git-file, git-directory, cluster, PR) produce many `Application` objects from that template.

- Pros: Perfect for **templated** apps — "one Application per environment" (dev/staging/prod), "one Application per Backstage-generated service", "one Application per Git PR" (preview environments). Cluster-generator can produce identical Applications across multiple ArgoCD-managed clusters with per-cluster values.
- Cons: The template constrains every generated Application to the same *shape*. Phase 2 apps have wildly different shapes (some are Helm charts, some are Kustomize, some are raw manifests; different destinations, different sync policies). Force-fitting them through one template creates ugly conditionals inside the template. **Right answer for Phase 6 (Backstage-generated services); wrong answer for Phase 2 platform bootstrap.**

### Option D — Helm-of-helms

A Helm chart whose templates render `Application` objects, parameterised via `values.yaml`.

- Pros: Deep parameterisation. Values files per environment. Familiar to Helm users.
- Cons: Adds a layer of abstraction (Helm rendering an Application which renders a Helm chart) with no immediate payoff — our five Phase 2 apps don't share enough shape to justify template-based parameterisation. When you find yourself writing `{{ if .Values.certManager.enabled }}` around a single Application, you've built the wrong tool. Also: Helm-of-helms is essentially "apps-of-apps with an extra rendering step" — the delta over Option B is a values-file for tuning knobs we don't currently have.

### Option E — Kustomize app-of-apps

App-of-apps with a `kustomization.yaml` overlay in the apps directory.

- Pros: Enables patch-based customisation across children — e.g., "prepend `platform-` to every Application's name."
- Cons: Solves a problem we don't have yet. Adds a layer between "the file on disk" and "the Application on the cluster" for zero current benefit. Rejecting for now; can add later as a non-breaking refactor if the need appears.

## Decision

**Option B — App-of-apps.**

Chosen because it maximally satisfies drivers 1–5 while being the simplest pattern that could plausibly work. Bootstrap survivability (driver 6) is handled by baking the one-time `kubectl apply` into a `Makefile` target (`make argocd-bootstrap-root`) so any fresh cluster comes online with a single command.

Option C (ApplicationSet) will be **added alongside** in Phase 6 for Backstage-generated services — the two patterns compose cleanly. App-of-apps handles hand-crafted platform components; ApplicationSet handles template-generated user-facing services. Both live under `platform/argocd/apps/` (Applications and ApplicationSets are both discovered from that directory).

## Consequences

- **Positive:** Adding a component is a one-file PR. Deleting one is a one-file PR (with automatic prune-and-cleanup). `git log platform/argocd/apps/` = the full history of every install/uninstall event on the platform. Cluster drift auto-corrects within ~3 minutes because `syncPolicy.automated.selfHeal: true`. Bootstrap is one command (`make argocd-bootstrap-root`). Each child Application has full independence in sync policy, source type (Helm/Kustomize/raw), destination namespace, and revision pinning. Zero coupling between children means removing one doesn't affect the others.
- **Negative:** `Application/root` is itself not GitOps-managed — it's the one imperative act. We could make it self-referential (root's source path could include `../root-app.yaml` itself), but that adds a subtle circular dependency for zero real gain: recovering from a broken root-app becomes harder because a bad merge could disable ArgoCD's ability to reconcile itself. Keeping root-app "outside the loop" makes it recoverable via `kubectl apply -f root-app.yaml` at any time. **We accept the one-file exception.**
- **Neutral:** The `apps/` directory currently contains only `.gitkeep`. Root-app in a Synced/Healthy state with zero children is legitimate — see the Task 2.2.f log where we confirmed this behaviour. When children are added, root-app briefly flips to `OutOfSync` on the next reconcile until the child Application object is created on the cluster, then returns to Synced.

## When to revisit

- **When Phase 6 arrives.** Add ApplicationSet alongside app-of-apps for Backstage-generated services. Do not rip out app-of-apps for platform components — they're the right tool for that job. The two patterns coexist.
- **If we grow past ~20 hand-crafted platform Applications.** At that scale, a naming convention + subdirectory structure (with `directory.recurse: true`) may become clearer than a flat list. Trigger to revisit: when scrolling `apps/` in an editor stops fitting on one screen.
- **If we start needing values-file parameterisation across children.** Then Option D (Helm-of-helms) or Option E (Kustomize) become worth reconsidering. Not before.
- **If root-app itself becomes a source of drift.** If we find that root-app is being manually edited on the cluster in ways that Git doesn't reflect, we may need to make it self-referential (adding it to its own source path) at the cost of the "safe recovery" property. Trigger: any incident where root-app is out of sync with Git and no one can remember why.

## Related decisions

- [ADR-0014](0014-argocd-raw-install-vs-helm.md) — how ArgoCD itself got installed. Prerequisite for this ADR to make sense.
- [ADR-0005](0005-local-first-development-with-kind.md) — the local-first posture means this pattern must work on kind first, EKS later.

## References

- [ArgoCD — App of Apps Pattern (upstream docs)](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/)
- [ArgoCD — ApplicationSet (the templating pattern we'll adopt in Phase 6)](https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/)
- [ArgoCD — Sync options (CreateNamespace, ServerSideApply, etc.)](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/)
- [ArgoCD — Automated sync policy (prune, selfHeal)](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)

## Interview framing

The one-liner: *"App-of-apps is the classical solution to ArgoCD's bootstrapping paradox: how does ArgoCD know what to install? Answer: one manual apply of a root Application that watches a Git directory; every YAML in that directory becomes a managed child Application. It's the shape of GitOps recursion — one imperative action, everything else declarative and reconciling. For template-generated apps (per-environment, per-service), you compose it with ApplicationSet; the two patterns coexist."*

## Postscript — the `directory.recurse: false` omitempty drift trap (learned during Task 2.3.f)

After shipping `cert-manager-issuers.yaml` as the second child under root, `argocd app list` showed:

```text
argocd/cert-manager           Synced     Healthy
argocd/cert-manager-issuers   Synced     Healthy
argocd/root                   OutOfSync  Healthy   ← wouldn't clear
```

Force-syncing root reported "successfully synced" every time, but the OutOfSync status returned within seconds. Every `argocd app diff root` produced the same delta:

```text
===== argoproj.io/Application argocd/cert-manager-issuers ======
>     directory:
>       recurse: false
```

Root's target state (from git) declared `spec.source.directory: { recurse: false }`; the live Application on the cluster had no `directory` field at all. Drift reported. Sync couldn't fix it — writing the field back had no persistent effect. **Permanent OutOfSync.**

**Root cause.** ArgoCD's `Application` CRD Go type declares:

```go
type ApplicationSourceDirectory struct {
    Recurse bool `json:"recurse,omitempty"`
}
```

The `omitempty` JSON tag on a Go `bool` means: **on serialization, drop the field if it equals the Go zero value.** For `bool`, that's `false`. So when we sent `recurse: false` to the API server, the server accepted it, stored it, and every subsequent read serialized it back with the field absent. Git had the field; cluster didn't. Diff reported it. Sync couldn't cure it.

**Fix.** Remove the field entirely from the Application manifest. `recurse: false` is already the default behaviour, so omitting the line changes nothing at runtime; it just stops the phantom drift. In our case: two edits (`cert-manager-issuers.yaml`, `root-app.yaml`) with inline comments explaining the pattern so future contributors don't reintroduce it. Commit `432add0`.

**The general pattern that applies far beyond ArgoCD.** *"Explicit zero value + `omitempty` = permanent GitOps drift"* bites **every tool that compares declared vs live state on Kubernetes resources.** Terraform hits it (usually surfaces as "always shows a diff"). Pulumi hits it. Crossplane's Composition YAMLs will hit it in Phase 4 when we start writing boolean fields. It's not an ArgoCD bug — it's a Kubernetes API server behaviour that any GitOps tool must reckon with.

**How to avoid it going forward.** Whenever you're setting a `bool` field to its zero value (`false`) in a k8s manifest, **check the CRD's Go struct definition** (or run `kubectl explain <resource>.<field>`) to see if the field has `omitempty`. If it does, don't set the value explicitly — the default is what you want anyway. Setting `true` is safe (non-zero values survive round-tripping); setting `false` is a trap. Same rule applies to any pointer-typed field with `omitempty` set to nil-equivalent values.

**Interview framing:** *"The most operationally-annoying bug in our GitOps setup wasn't in ArgoCD — it was in the JSON serialization tag on one Kubernetes CRD field. `omitempty` on a Go `bool` strips `false` values on write; the git declaration retained the field, the cluster stripped it, ArgoCD flagged perma-drift. The fix is a one-line YAML deletion. The lesson is universal: never set a boolean to its zero value in a k8s manifest whose CRD marks the field `omitempty`. Same class of bug bites Terraform, Pulumi, Crossplane — it's not tool-specific, it's a k8s API server behaviour."*
