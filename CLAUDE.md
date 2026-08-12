# Aperture Chat Automation Guide

This file supplements [AGENTS.md](AGENTS.md) for automated contributors. The
same public-repository, security, contribution, and validation rules apply to
every tool or model working in this repository.

## Working agreement

- Inspect the current branch and working tree before editing.
- Keep the requested scope narrow; do not combine unrelated cleanup with a
  feature or fix.
- Do not fabricate runtime behavior, test evidence, screenshots, or completion.
- Preserve authentication, tenant isolation, auditability, persistence, and
  provider-routing contracts.
- Use synthetic data in tests and visual proof.
- Never access, copy, or expose private deployment configuration while working
  on public source.
- Local-only instructions may be consulted for authorized operations, but their
  SSH key paths, host details, and deployment secrets must never be reproduced
  in tracked files, commits, logs, screenshots, reviews, or chat output.

## Review-ready output

Before handing work off, report:

- files changed;
- behavior changed and why;
- commands run and their results;
- risks, assumptions, and rollback notes;
- visual evidence for user-facing changes when practical.

Follow the `dev` -> `test` -> `main` promotion process in
[CONTRIBUTING.md](CONTRIBUTING.md). Automated work must not merge itself or
bypass an active human or agent review.
