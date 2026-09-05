# Contributing to Aperture Chat

Thank you for helping improve Aperture Chat. The project favors small,
inspectable changes that can be tested and reviewed without hiding unrelated
behavior.

By submitting a contribution, you confirm that you have the right to submit it
and agree that it may be distributed under [LICENSE.md](LICENSE.md). Public
forks must also preserve [NOTICE.md](NOTICE.md) and the required fork
provenance described in the license.

## Branch and promotion model

```text
external fork ─┐
               ├─> dev ─> test ─> main
org branch  ───┘       container     production
                       inspection
```

- `dev` is the integration branch. External contributors must fork the
  repository and open a pull request to `dev` from their fork.
- Organization contributors start from `dev`. A short-lived branch and pull
  request back to `dev` is preferred; a direct `dev` commit is acceptable only
  for a very small, authorized change.
- `test` receives promotion pull requests from `dev`. Each commit on `test`
  publishes immutable API and web container images for inspection.
- `main` is the production branch. Only `test` may be promoted to `main`, and
  the exact `test` commit must have both inspectable container images.
- Merge `test` into `main` with a merge commit. The release workflow verifies
  that the merge tree matches the inspected `test` parent, then promotes those
  exact multi-architecture image manifests without rebuilding them. Squash or
  rebase merges intentionally fail the release gate.
- Do not force-push shared branches or bypass a promotion stage.

## Keep changes iterative

A pull request should normally address one feature, one bug, or one cohesive
maintenance task. As a guideline, aim for fewer than about 500 net source lines
when the work can be split cleanly. Generated files, lockfiles, and necessary
test fixtures do not count toward that guideline.

Split a change when it combines independent behavior, touches unrelated roles
or subsystems, or would make rollback difficult. Large work can use a sequence
of draft pull requests so the owner and review agents can vet each piece.

## Required pull-request notes

Every pull request must explain:

1. what changed and why;
2. the exact scope and what was intentionally left out;
3. tests and checks that were run;
4. risks, migration or compatibility concerns, and rollback approach; and
5. any follow-up work.

Add code comments for non-obvious intent, security boundaries, or surprising
tradeoffs. Clear pull-request notes are always required; excessive comments on
obvious code are not.

For visible changes, include before/after screenshots or a short clip when
practical. Use synthetic accounts and data, redact sensitive information, and
show both light and dark themes when the change affects both.

## Local validation

Install the supported Node and Python versions, copy `.env.example` to `.env`,
and use non-secret local values. Run the checks that cover the changed surface:

```bash
npm run check:node-baseline
npm ci
npm --workspace apps/web run typecheck
npm run test:web -- --run
npm run build:web

cd services/api
python -m pip install -e ".[dev]"
ruff check .
python -m pytest
```

Also run `git diff --check` before requesting review.

## Branch container inspection

Every permanent branch publishes multi-architecture API and web images for
each commit. Moving branch tags are promoted only after both SHA images pass
architecture and build-digest inspection:

```text
ghcr.io/aperture-chat/aperture-chat-api:<dev|test|main>
ghcr.io/aperture-chat/aperture-chat-web:<dev|test|main>
```

Immutable tags retain the branch name and full commit SHA:

```text
ghcr.io/aperture-chat/aperture-chat-api:<branch>-<full-commit-sha>
ghcr.io/aperture-chat/aperture-chat-web:<branch>-<full-commit-sha>
```

The promotion pull request from `test` to `main` continues to verify that both
immutable `test-<full-commit-sha>` images exist. Reviewers can deploy the exact
pair with `docker-compose.release.yml` by setting
`APERTURE_IMAGE_TAG=test-<full-commit-sha>` in a disposable review environment.
The release-only `latest` tag is unchanged and is updated only by the Docker
release workflow. Never use a production data volume for contributor testing.
Alias updates are not atomic; use the verified SHA pair for deployments and
retain its digests for exact reproducibility. See the
[publication recovery runbook](docs/DOCKER_RELEASE.md#branch-images-and-failed-publications)
before deploying moving tags after a failed or canceled publication.

## Review and merge expectations

- Open substantial work as a draft pull request early.
- Do not mark it ready until the required notes and relevant checks are present.
- New commits after approval require another review of the changed material.
- Do not merge while automated checks, an assigned agent review, or owner
  review is still active.
- Maintainers may hold a change in `dev` or `test` for additional inspection;
  there is no fixed waiting period when the evidence is already sufficient.
- The owner or an explicitly delegated maintainer makes the final production
  promotion decision.

## Security and privacy

Do not include secrets, private infrastructure details, personal data,
production logs, customer documents, or live credentials in issues, commits,
screenshots, videos, or pull requests. Use the private reporting path in
[SECURITY.md](SECURITY.md) for suspected vulnerabilities.
