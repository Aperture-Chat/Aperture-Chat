# Aperture Chat Agent Workflow

This repository is a public, MIT-licensed open-source project. Treat every
tracked file, generated artifact, screenshot, log excerpt, and example as
information that can be read by anyone.

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

## Live development preview

When a live development instance is configured in ignored local instructions,
sync every source change there immediately and rebuild the affected container
so the owner can review it. Do not wait to be asked. Do not commit, push, or
open a pull request until the owner asks. Never copy local connection details
into this file or into chat.

## Contribution flow

Follow [CONTRIBUTING.md](CONTRIBUTING.md). In summary:

1. Every pull request targets `dev`. External contributors work from a fork;
   maintainers may push a short-lived branch to this repository instead.
2. Keep changes narrow and iterative. A pull request should normally contain
   one feature, one fix, or one cohesive maintenance task.
3. Promotion from `dev` to `test` to `main` is a maintainer task described in
   [docs/RELEASING.md](docs/RELEASING.md). Do not bypass a stage.
4. Do not merge while automated or human review is still active.

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
npm run test:web
npm run build:web
cd services/api && .venv/bin/ruff check . && .venv/bin/python -m pytest -q
```

Use the relevant subset for documentation-only changes. Checks for other areas
are listed in [CONTRIBUTING.md](CONTRIBUTING.md#run-the-checks); container
validation and promotion requirements are in [docs/RELEASING.md](docs/RELEASING.md).

## Guardrails

- Never reset volumes, erase runtime data, rewrite shared history, force-push,
  or change repository visibility without explicit owner approval.
- Keep platform-owner, tenant-admin, and user authorization boundaries intact.
- Keep the [MIT License](LICENSE.md) and its copyright notice with every copy
  and distribution.
