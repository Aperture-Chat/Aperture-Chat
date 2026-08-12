# Aperture Chat Agent Workflow

This repository is a public, source-available project. Treat every tracked file,
generated artifact, screenshot, log excerpt, and example as information that can
be read by anyone.

## Public-repository boundary

- Never commit credentials, tokens, private hostnames, IP addresses, SSH
  identities, local absolute paths, customer data, runtime databases, or
  production logs.
- Keep environment-specific instructions in an ignored `AGENTS.local.md` or
  another private system. Use placeholders such as `your-host` and
  `https://your-instance.example` in tracked examples.
- Automated contributors may consult local-only instructions for authorized
  operations, but must never copy, quote, summarize, or reveal SSH key paths,
  host details, or other deployment secrets in tracked files, commits, logs,
  screenshots, issue text, pull requests, or chat output.
- Use synthetic data for screenshots and recordings. Review visual assets for
  names, account details, keys, and private infrastructure before committing.
- Do not add generated success states, fabricated provider responses, or other
  behavior that makes the product appear more complete than it is.

## Contribution flow

Follow [CONTRIBUTING.md](CONTRIBUTING.md). In summary:

1. External contributors work from a fork and open a pull request to `dev`.
2. Organization contributors start from `dev` and should use a short-lived
   branch for anything beyond a very small change.
3. Keep changes narrow and iterative. A pull request should normally contain
   one feature, one fix, or one cohesive maintenance task.
4. Promotion follows `dev` -> `test` -> `main`. Do not bypass a stage.
5. A `test` commit must have inspectable API and web container images before it
   can be promoted to `main`.
6. Do not merge while automated or human review is still active.

## Change quality

- Explain what changed, why it changed, risks, and validation in the pull
  request. Good notes are required.
- Add comments where intent, security boundaries, or non-obvious tradeoffs
  would otherwise be unclear. Do not narrate obvious code.
- For visible changes, add screenshots or a short clip when practical. Use
  synthetic accounts and redact sensitive data.
- Update source, tests, documentation, and configuration together when a change
  affects their shared contract.
- Preserve unrelated work and avoid broad rewrites that make review difficult.

## Validation

Run checks proportional to the change. At minimum:

```bash
git diff --check
npm --workspace apps/web run typecheck
npm --workspace apps/web run test -- --run
npm run build:web
cd services/api && .venv/bin/python -m pytest -q
```

Use the relevant subset for documentation-only changes. Container validation
and promotion requirements are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## Guardrails

- Never reset volumes, erase runtime data, rewrite shared history, force-push,
  or change repository visibility without explicit owner approval.
- Keep platform-owner, tenant-admin, and user authorization boundaries intact.
- Respect [LICENSE.md](LICENSE.md) and preserve [NOTICE.md](NOTICE.md) in public
  forks and distributions.
