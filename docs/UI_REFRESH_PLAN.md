# Workspace experience refresh

This work preserves the existing platform contracts while improving usability,
visual consistency, onboarding and training. Use the validation checklist below when changing or publishing this experience.

## Design system

Retain the Aperture mark, Plus Jakarta Sans typography, and tenant-controlled
branding. Follow the current promotional site with warm light surfaces, deep ink dark
surfaces, cyan accents, restrained orbital details, and clear heading hierarchy.
Keep the welcome mark and greeting above the full-width composer, without
redundant workspace labels. Use consistent spacing and visible loading, empty,
failed and saved states. Support
light/dark themes, keyboard use, reduced motion and narrow screens.

## Scope and completion evidence

| Requirement | Evidence required | Validation |
| --- | --- | --- |
| Preserve platform functionality and authorization | Full frontend/API tests; real role-specific workflows | Covered by the checks below |
| Refresh the entire interface | Browser review of chat, drafts, agents, library, account, admin and owner views in both themes | Covered by the checks below |
| Sign-in, access requests and approvals | Request, approval, credential handoff, first sign-in, password renewal, MFA and retry checks | Covered by the checks below |
| Initial owner setup | Fresh isolated installation through first usable workspace | Verified in an isolated persisted installation |
| Fix usability and availability bugs | Regressions proving each failure and recovery path | Covered by the checks below |
| Deploy updates to development preview | Preserved source/configuration, successful container rebuilds, health and live interaction checks | API and web rebuilt; public health and final visual assets verified |
| Update training videos and PDFs | Accurate narration, fresh synthetic screenshots, role-complete guides, valid in-app links | Covered by the checks below |
| Update repository training artifacts | Matching public/repository PDFs, reproducible generators and coverage inventory | Covered by the checks below |
| Commit completed work to dev | Reviewed diff, clean checks, authorized dev push | Verify for each publication |
| Publish updated dev containers | Successful image workflow; immutable API/web digests and branch tags verified | Verify for each publication |

## Confirmed defects being addressed

- Password changes revoke the session that the frontend previously kept using.
- Knowledge file lookup cancels its own request and remains in a loading state.
- Failed library saves dismiss the editor; editing can overwrite hidden metadata.
- Provider registration failures fabricate successful local rows.
- Missing agent models are silently replaced by another model on save.
- Upload completion clears text or attachments staged after sending began.
- Composition Enter and shortcut-menu keyboard behavior can send unintended text.
- Diagram saves can use stale validation for newly edited source.
- Draft requests can save a different active document under an earlier ID.
- Draft history merging can discard the only local copy of a document.
- Account changes can write one user's local sidebar state into another account.
- Drawers leave keyboard focus outside their visible boundaries.
- Bulk administration hides partially successful operations.
- Narration generation attributes a lesson to the previous lesson's audio.
- Capture scripts silently skip steps while publishing incomplete screenshots.
- A failed optional-panel download reloads the whole page and loses unfinished chat work.
- Provider catalog sync marks a connection usable before receiving a validated result.
- Branch image aliases can advance to different commits after a partial build failure.
- Mobile draft controls remain reachable while their drawer is off screen.

## Implementation and verification

- Source changes include account security, session renewal, first-run guidance,
  recoverable saves, accessible modal navigation, mobile draft controls, and
  consistent light/dark styling. Unsaved Drafts now intercept global navigation
  and voluntary sign-out, including recovery when browser storage fails.
- The development deployment's newer source was backed up and reconciled.
  Restored features include owner-managed shared connectors and platform
  release updates. Connector credentials remain owner-only; personal OAuth
  and tenant content permissions retain their existing boundaries.
- The final API suite passed on Python 3.12 with no failures or skips, including
  checks for stale version overrides and fork release endpoints.
- The final web suite passes all 725 tests. Typechecking and the production
  build pass, including the sign-out, group selection, and detail alignment fixes.
- Actual synthetic browser workflows verify access requests, approval,
  temporary-password replacement, first sign-in, session rotation, MFA,
  recovery-code replacement, and disable/sign-out behavior. The empty-install browser workflow passes 20 checks, including one-time owner
  creation, welcome acknowledgment, persisted login, and server-side sign-out
  revocation that survives a process restart.
- A real provider returned text and generated an image in the isolated test
  workspace; reported usage, saved conversations, Draft generation, and the downloaded
  image were verified. The temporary test credential was removed after capture.
- Training narration, screenshots, measured focus regions, and guide sources
  follow the current design. The complete coverage and verification inventory
  is maintained in [TRAINING.md](TRAINING.md).
- Branch publication verifies both architecture-complete SHA images before
  promoting aliases. Registry recovery simulations and release-updater tests
  pass. The initial development rebuild is live with healthy API and public assets.
  Disposable Docker tests prove successful updating and exact-image recovery
  after either service fails, with synthetic data retained and all test
  resources removed. Every publication must verify the CI result and both immutable
  API/web image digests before relying on the moving branch aliases.

## Validation boundaries

Use isolated synthetic data for browser tests and training. Do not publish
private accounts, deployment details or runtime state. A seeded model row or
mocked unit-test response does not prove a provider integration. Keep any
unverified live path explicitly pending; successful unit tests do not complete
the platform-wide browser or deployment checks.

## Update installation boundary

Update notices compare the running package version against the configured
repository's stable releases. An old environment override cannot advertise an
already installed release. Only a ready updater offers one-click installation;
other deployments display release availability and manual setup guidance.

The reviewed release bundle includes a fresh-install script with private
configuration, a generated secret, a stable project identity, and configurable
fork image/release sources. Existing installations must retain their project,
volumes, and secrets during the one-time updater setup. See
[Docker Deployment](DOCKER_RELEASE.md) for prerequisites and migration limits.
