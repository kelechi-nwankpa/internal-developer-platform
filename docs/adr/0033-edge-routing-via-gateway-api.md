# 0033 — Route edge traffic through the Gateway API; ship no Ingress until then

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** project owner
- **Consulted:** —
- **Informed:** future contributors

## Context and problem statement

Since Phase 6 the golden-path template has shipped an `Ingress` (class
`nginx`), a cert-manager `Certificate` and an external-dns hostname for
every service. The Ingress said it would be "enabled once Phase 8
installs nginx-ingress". That never happened: the cluster has no ingress
controller, so the Ingress never received an address and nothing ever
used it. Every service on kind is reached with `kubectl port-forward`.

The dead Ingress was not harmless:

- ArgoCD reports an Ingress without a load-balancer address as
  **Progressing**, so platform-hello could never be Healthy. That is
  permanent noise of exactly the kind that hid three real outages for 37
  days (Phase 8 Wave 4).
- Its `cert-manager.io/cluster-issuer` annotation made cert-manager's
  ingress-shim manage a second copy of the explicit Certificate; the two
  writers fought and the Certificate was OutOfSync forever.

Meanwhile the obvious completion, installing ingress-nginx, is no longer
a good choice: the Kubernetes project retired ingress-nginx (announced
November 2025, maintenance ended March 2026). The ecosystem's successor
is the **Gateway API** (`Gateway` + `HTTPRoute`).

## Decision drivers

- What is in Git must be true: no manifests for capabilities that don't exist.
- No permanent non-Healthy state; it trains people to ignore alerts.
- Don't adopt an unmaintained edge component.
- The edge design should be done once, for kind and EKS together, with
  TLS and DNS (cert-manager, external-dns, ADR-0021) in the same design.
- Local-first and $0: no cluster recreation in the middle of a cleanup wave.

## Options considered

### Option A — Remove the Ingress now; adopt the Gateway API with EKS (Phase 9)

Delete `ingress.yaml` and `certificate.yaml` from the template and
platform-hello. Services stay ClusterIP; on kind use `port-forward` (as
today). Phase 9 introduces a Gateway API implementation and the template
gains an `HTTPRoute`.

- ✅ Git matches reality; platform-hello becomes Healthy; no fighting writers.
- ✅ The edge is designed once, with TLS/DNS, for both environments.
- ❌ No HTTPS hostname on kind until Phase 9 (there isn't one today either).

### Option B — Install a Gateway API implementation now (e.g. Envoy Gateway) and migrate the template

- ✅ Real edge routing on kind immediately.
- ❌ A large new component inside a cleanup wave; kind also needs host
  port mappings (`extraPortMappings`), which are set at cluster creation,
  so the cluster would likely be recreated.

### Option C — Custom ArgoCD health check treating address-less Ingresses as Healthy

- ✅ Silences the status in minutes.
- ❌ Hides a true fact. The "ignore this drift" pattern is precisely what
  hid the Wave 4 outages. Rejected.

### Option D — Install ingress-nginx as originally planned

- ❌ Retired upstream; would adopt an unmaintained component on the edge,
  the most exposed part of the platform. Rejected.

## Decision

**Option A.** The template and platform-hello ship no Ingress or
Certificate. Edge routing will use the **Gateway API**, implemented with
EKS in Phase 9 (implementation choice, e.g. Envoy Gateway vs the AWS
Gateway API controller, decided then), and the template will gain an
`HTTPRoute`.

## Consequences

- platform-hello is Synced/Healthy; all 27 Applications are clean.
- New services are reached with `kubectl port-forward svc/<name> 3000:3000` on kind.
- `catalog-info.yaml` links to `*.idp.seniormankelz.dev` remain
  aspirational until Phase 9 publishes those hostnames.
- `trustProxy: true` stays in the app so client IPs are correct once a
  Gateway sits in front.

## When to revisit

- When Phase 9 starts (EKS): this becomes the edge-routing design task.
- Earlier if a kind workflow genuinely needs a hostname (e.g. OAuth
  callbacks to a service other than Backstage).

## Related decisions

- [ADR-0021](0021-external-dns-install-and-provider-strategy.md) — DNS automation that the Gateway design must keep working
- [ADR-0014](0014-argocd-raw-install-vs-helm.md) — why fixes here avoid ArgoCD-wide config
- Phase 8 Wave 4 log (`docs/phases/phase-8-security-hardening.md`) — the outages this noise hid

## References

- Kubernetes Gateway API: <https://gateway-api.sigs.k8s.io/>

## Update 2026-11-21 — implemented on kind in Phase 9

The Gateway API edge now exists (`platform/gateway/`, Applications
`envoy-gateway` and `gateway`). Decisions taken at implementation:

- **Controller: Envoy Gateway 1.9.4.** Same behaviour on kind and EKS.
  The AWS Gateway controller works only on AWS (nothing to test locally);
  Istio and Cilium bring a mesh or a CNI swap this platform does not need.
- **One shared Gateway** (`gateway/edge`), owned by the platform. Teams
  own an `HTTPRoute` in their own namespace.
- **Deny-by-default attachment.** Only namespaces labelled
  `edge.idp.seniormankelz.dev/allow-routes: "true"` may attach, and only
  to the HTTPS listener. The label is set in the platform repo.
- **One platform wildcard certificate** (`*.idp.seniormankelz.dev`),
  explicit `Certificate`, self-signed on kind, DNS-01 on EKS.
- **HTTP is redirect-only** (301 to HTTPS).
- **kind exposure: hostPort 80/443** on the proxy pod. This needs Pod
  Security `privileged` on the `gateway` namespace only; on EKS the proxy
  sits behind an NLB and the namespace returns to `restricted`.
  `privileged` checks nothing, so a Kyverno policy
  (`platform/kyverno/policies/restrict-gateway-namespace.yaml`, Enforce)
  re-applies every `baseline` check there and allows host ports 80 and
  443 only.

**Correction to Option B above.** It says kind "would likely be
recreated" to add host port mappings. That was wrong:
`platform/kind/kind-config.yaml` has mapped ports 80 and 443 since the
cluster was created. No recreation was needed. The other reason for
deferring (a large new component inside a cleanup wave) still stands.

Verified: `curl -k --resolve platform-hello.idp.seniormankelz.dev:443:127.0.0.1
https://platform-hello.idp.seniormankelz.dev/hello` returns 200 with the
S3 round-trip; plain HTTP returns 301.
