# Training content and publication

Training ships with the web application. Help opens the user library; Documentation in each console opens its role library. These are browser-rendered narrated walkthroughs assembled from captured PNGs, MP3 narration, captions, transcripts, and scene timelines. They are not standalone MP4 files.

## Current inventory

The training set contains **44 lessons, 191 scenes, 44 MP3 tracks, and 3,034 seconds of narration timelines (50 minutes 34 seconds)**. Its 187 measured focus-map entries comprise 81 user targets and 106 administrator/owner targets. Scene counts and reusable focus-map entries are counted independently.

| Audience | Lessons | Scenes | Measured focus entries | MP3s | Seconds | Guide sections |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| User | 19 | 86 | 81 | 19 | 1300 | 24 |
| Administrator | 12 | 49 | 49 | 12 | 868 | 37 |
| Platform owner | 13 | 56 | 57 | 13 | 866 | 54 |
| Total | 44 | 191 | 187 | 44 | 3034 | — |

All three downloadable guides have byte-identical copies in `apps/web/public/docs/` and `docs/`: `aperture-user-guide.pdf`, `aperture-admin-guide.pdf`, and `aperture-owner-guide.pdf`. The 24/37/54 section counts are role-filtered: administrator guides include user sections, and the owner guide includes both user and administrator sections.

Lesson counts and timings below are generated from the TypeScript catalog with `--include-drafts`; focus maps, MP3 counts, guide sections, and PDF-copy equality are checked separately. Including drafts inventories proposed content; it never publishes a lesson.

## Sources

| Source | Responsibility |
| --- | --- |
| `apps/web/src/components/trainingDecks/{user,admin,owner}.tsx` | Lesson content, setup steps, narration, timing, and measured frame targets. |
| `apps/web/src/components/TrainingVideoLibrary.tsx` | Role libraries, player, transcript, and guide downloads. |
| `apps/web/src/components/trainingVideoKit.tsx` | 1185 × 855 composition at 30 fps; image fit, highlights, callouts, and captions. |
| `apps/web/scripts/training-catalog.cjs` and `audit-training.cjs` | Inventory, media/timing checks, capture contracts, and PDF-copy checks. |
| `apps/web/scripts/training-focus-measurement.cjs` and `apply-training-focus.cjs` | DOM measurements and imports verified against the exact public PNG bytes. |
| `apps/web/scripts/training-frame-aliases.cjs` | Byte-identical onboarding views of reviewed model access, account management, and a genuine user reply. |
| `apps/web/scripts/generate-training-narration.py` | Per-scene speech, MP3 encoding, timing updates, and private build evidence. |
| `apps/web/scripts/guide-pdfs/{content,render,generate}.cjs` | Written guides, print layout, contents pagination, and matching PDF publication. |
| `apps/web/public/training/{user,admin,owner}/` | Served screenshots and narration. |
| `docs/images/` and `README.md` | Product overview screenshots and role-guide links. |

## Lesson inventory

Seconds are the sum of each lesson's source scene durations.

| Audience | Title | Lesson ID | Scenes | Seconds |
| --- | --- | --- | ---: | ---: |
| User | Agent profiles | `agents` | 3 | 46 |
| User | Attach files and sources | `attachments` | 4 | 44 |
| User | Build a slide deck | `deck-basics` | 12 | 154 |
| User | Composer symbol shortcuts | `composer-commands` | 4 | 55 |
| User | Dictation, images, and diagrams | `dictation-images` | 4 | 52 |
| User | Draft documents | `drafts` | 5 | 88 |
| User | Follow the work trace | `work-traces` | 4 | 50 |
| User | Knowledge bases | `knowledge` | 3 | 40 |
| User | Knowledge, Web, Agent, and reasoning | `send-options` | 5 | 50 |
| User | Organize and find your work | `organize` | 5 | 53 |
| User | Personalization memory | `personalization-memory` | 4 | 81 |
| User | Personalize, use mobile, and get help | `account-mobile-help` | 8 | 150 |
| User | Preview chats at a glance | `chat-previews` | 1 | 29 |
| User | Protect your account and recover access | `account-security` | 6 | 131 |
| User | Request access and enter your workspace | `access-and-sign-in` | 5 | 100 |
| User | Scheduled automations | `scheduled-automations` | 4 | 54 |
| User | Session details and context | `session-details` | 2 | 33 |
| User | Start chatting | `chat-basics` | 4 | 50 |
| User | Tools and the Library | `tools-automations` | 3 | 40 |
| Administrator | Alerts and delivery | `admin-alerts` | 4 | 67 |
| Administrator | Approve access and finish sign-in | `admin-access-onboarding` | 5 | 96 |
| Administrator | Data retention and tagging | `admin-retention` | 6 | 94 |
| Administrator | Groups and permissions | `admin-groups` | 4 | 63 |
| Administrator | Policies and memory governance | `admin-policies` | 5 | 96 |
| Administrator | Response actions and connector responsibilities | `admin-tools` | 3 | 62 |
| Administrator | Review feedback and reported issues | `admin-feedback-issues` | 4 | 78 |
| Administrator | Tenant SSO and provisioning | `admin-sso` | 4 | 64 |
| Administrator | Tenant analytics | `admin-analytics` | 4 | 74 |
| Administrator | Tenant audit | `admin-audit` | 3 | 56 |
| Administrator | Tenant model access | `admin-model-access` | 3 | 49 |
| Administrator | Users and accounts | `admin-users` | 4 | 69 |
| Platform owner | API Key Vault and replacement | `api-key-vault` | 3 | 39 |
| Platform owner | Alerts and email delivery | `owner-alerts` | 4 | 61 |
| Platform owner | Analytics: runtime, activity, and usage | `runtime-analytics` | 6 | 88 |
| Platform owner | Data retention and tagging | `owner-retention` | 6 | 95 |
| Platform owner | Organization model availability | `model-availability` | 3 | 36 |
| Platform owner | Owner audit signals | `owner-audit` | 5 | 68 |
| Platform owner | Platform branding | `branding` | 4 | 57 |
| Platform owner | Policies, budget, and connectors | `policies-connectors` | 5 | 98 |
| Platform owner | Providers and connections | `provider-setup` | 4 | 65 |
| Platform owner | SSO provisioning and go-live | `sso-security` | 3 | 40 |
| Platform owner | Set up the first workspace | `owner-first-workspace` | 5 | 104 |
| Platform owner | Single sign-on setup | `sso-setup` | 4 | 58 |
| Platform owner | Users and role boundaries | `users-roles` | 4 | 57 |

## Rebuild workflow

### 1. Freeze the UI and prepare real synthetic fixtures

Review lessons and written guides against final UI labels and behavior. Use Node 24 or newer, Playwright with Chromium, and FFmpeg/FFprobe. Capture scripts require `playwright`; PDF generation requires `playwright-core` and Python with `pypdf`. Resolve tooling through the installed environment or `NODE_PATH`.

Use loopback application/API origins and synthetic accounts for each role. Prefer `CAPTURE_SESSION_FILE` containing an actual sign-in response in an ignored, privately readable file. Keep passwords, tokens, provider keys, authenticator QR secrets, and recovery codes out of tracked files and public screenshots. Set `CAPTURE_PUBLIC_SYNTHETIC_CONFIRMATION=I_HAVE_REVIEWED_SYNTHETIC_DATA` after reviewing the fixture; each script header documents its additional inputs.

Provider-dependent scenes require a real configured provider, successful runtime validation, persisted replies or generated images, and actual reported usage. A saved key, selected model, imported example, or empty panel does not establish a successful provider result. Teach unavailable states honestly; never substitute fabricated success.

Use a separate disposable store for authoring fixtures requiring broader permissions. Its synthetic knowledge file must actually index; saved agent/tool definitions and a paused automation demonstrate configuration, not successful execution. Do not copy a working provider credential or broaden the main instance's policy for a configuration screenshot.

### 2. Capture the required states

Run from the repository root with the intended synthetic role session. Read each script's fixture prerequisites and mutation scope.

| Capture task | Scripts under `apps/web/scripts/` |
| --- | --- |
| User chat, navigation, documents, and decks | `capture-training-frames.cjs`, `capture-deck-frames.cjs` |
| Administrator console, policies, analytics, and audit | `capture-admin-frames.cjs`, `capture-admin-analytics-frames.cjs` |
| Owner configuration, connectors, usage, audit, and retention | `capture-owner-frames.cjs` |
| Account, Help, and mobile installation UI | `capture-user-support-frames.cjs` |
| Real request, approval, password, authenticator, recovery, and logout lifecycle | `capture-auth-onboarding-frames.cjs` |
| Actual first-owner bootstrap and welcome | `capture-first-owner-frames.cjs` |
| One authorized synthetic issue with a reviewed attachment | `capture-report-submission.cjs` |
| Existing feedback and the selected issue detail | `capture-admin-support-frames.cjs` |
| Actual policy-restricted SSO panel | `capture-admin-sso-readonly-frames.cjs` |
| Already validated provider card with its key vault closed | `capture-owner-provider-readiness.cjs` |

The auth lifecycle requires `CAPTURE_AUTH_MUTATION_CONFIRMATION=I_APPROVE_SYNTHETIC_AUTH_MUTATIONS` and a new private recovery-state file. First-owner capture requires an empty isolated API with demo/owner seeds disabled, a private owner fixture, and `CAPTURE_MUTATION_ACK=isolated-synthetic`; relogin mode checks persistence after a controlled isolated restart. Issue submission requires its explicit one-report acknowledgment and a new receipt. Use `CAPTURE_ISSUE_ID` to review that exact saved report. Read-only support scripts do not create missing ratings or reports.

SSO footage depends on actual service policy. The editable `sso-form.png` must come from an isolated fixture that really permits delegated administration; the restricted state uses `sso-readonly.png`. Preserve the main policy and never use one state as evidence of the other's controls. `users-actions.png` similarly records a real horizontal scroll to expose account actions at the capture viewport.

Baseline scripts stage complete batches under ignored `tmp/training-captures/` before copying declared frames to public assets; failed batches retain the prior files. Auth and support captures remain in review storage until publication. Inspect every image before release for synthetic data, hidden secrets, hover tooltips, current styling, and the narrated controls. Retain image hashes and measured targets together.

### 3. Regenerate narration without concurrent source edits

Use Python 3.12 with Kokoro, SoundFile, NumPy, and FFmpeg. Keep the environment, intermediate WAVs, and manifest under ignored `tmp/tts/`; the selected model and voice must be installed.

```bash
python3 apps/web/scripts/generate-training-narration.py --dry-run
tmp/tts/.venv/bin/python apps/web/scripts/generate-training-narration.py
```

Use `--decks` and `--videos` for bounded regeneration. `--include-drafts` is explicit and does not promote content. The generator pads scenes to whole seconds, encodes MP3s, updates scene durations, and preserves unselected manifest records. Keep the selected role source unchanged until synthesis finishes. Listen to changed lessons against their transcripts; matching duration alone does not verify speech.

### 4. Apply reviewed measurements and publish complete lessons

Use DOM bounds from the exact captured state. Normalize auth/support metadata into the importer's `{ frame, rect, zoom: 1 }` format and retain each source PNG beside its measurements. Desktop targets use the 1185 × 855 composition. Portrait captures use `fit: "contain"`: scale the source viewport proportionally, center it in the composition, and transform each rectangle with the same scale and offset. Do not stretch phone images or apply the transform twice.

```bash
node apps/web/scripts/apply-training-focus.cjs ROLE MEASUREMENTS.json
node apps/web/scripts/training-frame-aliases.cjs --reviewed-captures
```

The importer requires fresh role coverage by default and rejects public PNGs that differ from measured files. Reserve `--allow-partial` for a deliberate bounded recapture. Apply source edits after narration generation finishes. Publish aliases only after reviewing their source images; their bytes must remain identical. A lesson enters the active library only when its real frames, measured focus regions, narration, and timing are complete.

### 5. Rebuild written guides and README media

```bash
node apps/web/scripts/guide-pdfs/generate.cjs
```

Set `GUIDE_PDF_PYTHON` when needed. The generator verifies section coverage and stable contents pagination, then writes matching copies to both distribution directories. Render every PDF page with Poppler or an equivalent renderer and inspect clipping, wrapping, tables, headings, links, and page numbers. Refresh reviewed screenshots in `docs/images/`, confirm the README represents the same UI, and check its three role-guide links.

### 6. Validate the libraries and release artifacts

```bash
node apps/web/scripts/training-catalog.cjs user --include-drafts
node apps/web/scripts/training-catalog.cjs admin --include-drafts
node apps/web/scripts/training-catalog.cjs owner --include-drafts
node apps/web/scripts/training-focus-measurement.cjs
python3 apps/web/scripts/test_training_narration.py
node --test apps/web/scripts/training-catalog.test.cjs apps/web/scripts/training-capture-run.test.cjs apps/web/scripts/training-focus-measurement.test.cjs apps/web/scripts/apply-training-focus.test.cjs
node apps/web/scripts/audit-training.cjs --check
npm --workspace apps/web run typecheck
npm --workspace apps/web run test -- --run
npm run build:web
git diff --check
```

Exercise every role playlist: start narration, seek through every scene, check image/audio requests, captions and transcripts, use keyboard/back/close controls, and download each PDF. Check desktop and mobile layouts and compare downloaded guide bytes with repository copies. Inventory and unit checks do not certify playback or visual quality. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) for release promotion, then verify deployed assets and playback again.

## Current verification

The reviewed capture set has no unresolved capture gaps. All 44 lessons passed browser playback checks: audio loaded and played, transcripts matched, all 191 scenes were seekable, and each downloaded PDF matched its repository copy. All 117 guide pages were reviewed. The README tour uses 15 reviewed synthetic captures over 75 seconds. The release updater has written installation and recovery guidance; its real Docker update and rollback tests are separate from the narrated lesson library.
