# Promotion and Releases

This page is for maintainers. Contributors only need
[CONTRIBUTING.md](../CONTRIBUTING.md): every pull request targets `dev`, and
maintainers carry merged work the rest of the way.

## Branches

```text
contributor fork ─┐
                  ├─> dev ─> test ─> main ─> vX.Y.Z tag
maintainer branch ┘   integration  container   release
                                   inspection
```

- `dev` is the integration branch. Feature, fix, and documentation pull
  requests merge here after CI passes and a maintainer reviews them.
- `test` receives promotion pull requests from `dev` only. Each commit on
  `test` publishes immutable API and web container images for inspection.
- `main` receives promotion pull requests from `test` only, and only after both
  images for the exact `test` commit are inspectable.
- The Promotion Policy workflow enforces these sources. Promotion pull requests
  need an approving review from someone other than the author and green
  required checks.
- Don't force-push shared branches or skip a stage.

## Promotion pull requests

- Merge promotions with a merge commit. The release workflow verifies that the
  `main` merge tree matches the inspected `test` parent, then promotes those
  exact multi-architecture image manifests without rebuilding them. Squash or
  rebase merges intentionally fail the release gate.
- For a `test` to `main` promotion, list the image pair being promoted:

  ```text
  ghcr.io/aperture-chat/aperture-chat-api:test-<full-commit-sha>
  ghcr.io/aperture-chat/aperture-chat-web:test-<full-commit-sha>
  ```

- Hold a change in `dev` or `test` for more inspection whenever it's warranted.
  There is no fixed waiting period when the evidence is already sufficient.
- Don't merge while automated checks or a requested review are still running.
  New commits after an approval need another review of the changed material.
- The owner or an explicitly delegated maintainer makes the final production
  promotion decision.

## Branch container images

Every permanent branch publishes multi-architecture API and web images for each
commit. Moving branch tags are updated only after both SHA images pass
architecture and build-digest inspection:

```text
ghcr.io/aperture-chat/aperture-chat-api:<dev|test|main>
ghcr.io/aperture-chat/aperture-chat-web:<dev|test|main>
```

Immutable tags carry the branch name and full commit SHA:

```text
ghcr.io/aperture-chat/aperture-chat-api:<branch>-<full-commit-sha>
ghcr.io/aperture-chat/aperture-chat-web:<branch>-<full-commit-sha>
```

Reviewers can deploy an exact pair with `docker-compose.release.yml` by setting
`APERTURE_IMAGE_TAG=test-<full-commit-sha>` in a disposable review environment.
Never use a production data volume for review. Alias updates are not atomic, so
deploy the verified SHA pair and keep its digests for exact reproducibility.
Read [branch images and failed publications](DOCKER_RELEASE.md#branch-images-and-failed-publications)
before deploying moving tags after a failed or canceled publication.

## Versioned releases

Pushing a `vX.Y.Z` tag on a `main` merge commit runs the Docker Release
workflow. It promotes the inspected `test-<sha>` manifests to `vX.Y.Z` and
`latest` without rebuilding, and publishes the GitHub release. The release-only
`latest` tag changes only through that workflow. Release notes come from the
newest `New Since` section of [DOCKER_RELEASE.md](DOCKER_RELEASE.md).
