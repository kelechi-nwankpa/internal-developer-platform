# Architecture

This directory holds the durable architecture artefacts:

- **Context diagrams** — what the platform is, who uses it, what it touches.
- **Container / component diagrams** — the C4-model views of internal structure.
- **Sequence diagrams** — key flows (e.g. "developer clicks Create Service", "GitOps sync", "on-call debugs a failed pod").
- **Infra diagrams** — AWS-level topology (VPC, subnets, EKS, RDS, Route53).

## Diagram-as-code

Diagrams should be stored **as text** (Mermaid, PlantUML, D2, or `diagrams.py`) — not as binary PNGs alone. Reasons:

- Reviewable in PRs (a picture change becomes a diff).
- Versionable — the diagram evolves with the code.
- Reproducible — anyone can regenerate the rendered image.

Rendered PNG/SVG copies are checked in alongside the source so GitHub renders them in the README without a build step.

## Contents (grows per phase)

| File | Introduced in | Purpose |
|---|---|---|
| _(placeholder — first diagram lands in Phase 1)_ | Phase 1 | AWS baseline topology |

## References

- [C4 Model](https://c4model.com/)
- [Mermaid](https://mermaid.js.org/)
- [D2](https://d2lang.com/)
