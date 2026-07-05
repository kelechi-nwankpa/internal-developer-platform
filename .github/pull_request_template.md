<!--
Thanks for opening a PR. Please fill in every section below.
Empty sections signal weak PRs; a short-but-real answer is better than none.

Delete these comment blocks before submitting — they're just guidance for you.
-->

## Summary

<!-- What does this PR do, and *why*? 1–3 sentences. -->



## Type of change

<!-- Check all that apply. -->

- [ ] feat — new capability
- [ ] fix — bug fix
- [ ] docs — documentation only
- [ ] refactor — restructures without changing behaviour
- [ ] chore — tooling, dependencies, housekeeping
- [ ] test — adds or improves tests
- [ ] ci — CI/CD pipeline change
- [ ] perf — performance improvement
- [ ] security — security-relevant change

## Related ADR

<!--
Any change to /infra, /platform, /portal, /templates, or that introduces a
new architectural pattern MUST reference an ADR. Choose one:

  1. Link an existing ADR:      docs/adr/NNNN-title.md
  2. Reference a new ADR added in this PR (list the file).
  3. If truly no ADR is needed, add the `no-adr-required` label AND write
    one sentence below explaining why.

Skipping this is the fastest way to lose architectural memory.
-->

- ADR:

## Testing

<!-- How was this verified? -->

- [ ] Local checks pass (`make lint`, `make test`, etc.)
- [ ] Manually verified (describe steps below)
- [ ] Not applicable (docs / config only)

<!-- Manual verification steps, if any: -->



## Cost impact

<!--
Does this add ongoing AWS spend? If yes, quantify the monthly delta and
justify it. Fits within the $30 project budget cap? See docs/COST.md.
-->

- [ ] No ongoing cost impact
- [ ] Cost impact: **$_ /month** — reason:
- [ ] One-off cost during testing: **$_** — reason:

## Security considerations

<!--
Any changes to IAM, secrets, network policy, encryption, image supply chain,
or authentication/authorization? If yes, describe the threat model and the
mitigation. If no, say "none".
-->



## Checklist

<!-- Non-negotiables from CLAUDE.md §9. -->

- [ ] No secrets in the diff (real, test, or example)
- [ ] No `:latest` image tags in Kubernetes manifests
- [ ] No IAM policies with `*` action or `*` resource on write operations without an ADR justifying the deviation
- [ ] No always-on AWS resources introduced during development
- [ ] Documentation updated (README / phase log / runbook, as applicable)
- [ ] Pre-commit hooks pass locally
