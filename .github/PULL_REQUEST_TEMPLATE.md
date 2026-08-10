## Summary

<!-- What changed, and why is this change needed? -->

## Scope

<!-- What is included? What did you intentionally leave out? -->

## Validation

<!-- List exact commands and results. Do not write only "tests pass." -->

## Visual proof

<!-- For visible changes, add synthetic-data screenshots or a short clip when practical. Delete this section when not applicable. -->

## Risk and rollback

<!-- Describe behavior, security, migration, compatibility, and rollback concerns. -->

## Container inspection

<!-- Required for test -> main promotion. -->

- API image: `ghcr.io/aperture-chat/aperture-chat-api:test-<full-commit-sha>`
- Web image: `ghcr.io/aperture-chat/aperture-chat-web:test-<full-commit-sha>`

## Checklist

- [ ] This pull request contains one cohesive change or an intentionally small batch.
- [ ] I included clear implementation and review notes.
- [ ] I added focused tests or explained why tests are not applicable.
- [ ] I ran the relevant checks and recorded their exact results.
- [ ] I updated documentation and configuration when their contract changed.
- [ ] Visual evidence uses synthetic data and contains no private information.
- [ ] I did not commit secrets, production data, private infrastructure, or customer information.
- [ ] I have the right to submit this contribution under `LICENSE.md`.
- [ ] No automated or human review is still active at merge time.
- [ ] A `test` -> `main` promotion will use a merge commit so the inspected test commit remains verifiable.
