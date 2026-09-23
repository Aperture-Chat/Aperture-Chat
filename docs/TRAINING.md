# Training content and publication

Training ships with the web application. Help opens the user library; Documentation in each console opens its role library. These are browser-rendered narrated walkthroughs assembled from captured PNGs, MP3 narration, captions, transcripts, and scene timelines. They are not standalone MP4 files.

## Current inventory

The training set contains **49 lessons, 224 scenes, 49 MP3 tracks, and 3,910 seconds of narration timelines (65 minutes 10 seconds)**. Its 220 measured focus-map entries comprise 97 user targets and 123 administrator/owner targets. Scene counts and reusable focus-map entries are counted independently.

| Audience | Lessons | Scenes | Measured focus entries | MP3s | Seconds | Guide sections |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| User | 22 | 103 | 97 | 22 | 1714 | 26 |
| Administrator | 13 | 57 | 58 | 13 | 1096 | 40 |
| Platform owner | 14 | 64 | 65 | 14 | 1100 | 58 |
| Total | 49 | 224 | 220 | 49 | 3910 | — |

All three downloadable guides have byte-identical copies in `apps/web/public/docs/` and `docs/`: `aperture-user-guide.pdf`, `aperture-admin-guide.pdf`, and `aperture-owner-guide.pdf`. The 26/40/58 section counts are role-filtered: administrator guides include user sections, and the owner guide includes both user and administrator sections.

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
| User | Agent profiles | `agents` | 3 | 51 |
| User | Attach files and sources | `attachments` | 4 | 44 |
| User | Build a slide deck | `deck-basics` | 12 | 164 |
| User | Choose models and request access | `model-access` | 4 | 79 |
| User | Composer symbol shortcuts | `composer-commands` | 4 | 57 |
| User | Dictation, images, and diagrams | `dictation-images` | 4 | 52 |
| User | Draft documents | `drafts` | 6 | 115 |
| User | Follow the work trace | `work-traces` | 4 | 50 |
| User | Knowledge bases | `knowledge` | 3 | 40 |
| User | Knowledge, Web, Agent, and reply settings | `send-options` | 6 | 73 |
| User | Organize and find your work | `organize` | 6 | 89 |
| User | Personalization memory | `personalization-memory` | 4 | 81 |
| User | Personalize, use mobile, and get help | `account-mobile-help` | 9 | 172 |
| User | Preview chats at a glance | `chat-previews` | 1 | 29 |
| User | Protect your account and recover access | `account-security` | 7 | 154 |
| User | Request access and enter your workspace | `access-and-sign-in` | 5 | 100 |
| User | Save, organize, and recover your drafts | `save-and-recover-work` | 4 | 83 |
| User | Scheduled automations | `scheduled-automations` | 4 | 56 |
| User | Search, commands, and workspace links | `search-and-commands` | 4 | 79 |
| User | Session details and context | `session-details` | 2 | 43 |
| User | Start chatting | `chat-basics` | 4 | 55 |
| User | Tools and the Library | `tools-automations` | 3 | 48 |
| Administrator | Alerts and delivery | `admin-alerts` | 4 | 67 |
| Administrator | Approve access and finish sign-in | `admin-access-onboarding` | 5 | 96 |
| Administrator | Data retention and tagging | `admin-retention` | 10 | 208 |
| Administrator | Groups and permissions | `admin-groups` | 4 | 63 |
| Administrator | Policies and memory governance | `admin-policies` | 5 | 105 |
| Administrator | Response actions and connector responsibilities | `admin-tools` | 3 | 62 |
| Administrator | Review feedback and reported issues | `admin-feedback-issues` | 4 | 78 |
| Administrator | Review model requests and explain access | `admin-model-requests` | 4 | 83 |
| Administrator | Tenant analytics | `admin-analytics` | 4 | 74 |
| Administrator | Tenant audit | `admin-audit` | 3 | 62 |
| Administrator | Tenant model access | `admin-model-access` | 3 | 49 |
| Administrator | Tenant SSO and provisioning | `admin-sso` | 4 | 70 |
| Administrator | Users and accounts | `admin-users` | 4 | 79 |
| Platform owner | Alerts and email delivery | `owner-alerts` | 4 | 61 |
| Platform owner | Analytics: runtime, activity, and usage | `runtime-analytics` | 6 | 88 |
| Platform owner | API Key Vault and replacement | `api-key-vault` | 3 | 39 |
| Platform owner | Data retention and tagging | `owner-retention` | 10 | 208 |
| Platform owner | Organization model availability | `model-availability` | 3 | 36 |
| Platform owner | Owner audit signals | `owner-audit` | 5 | 74 |
| Platform owner | Platform branding | `branding` | 4 | 57 |
| Platform owner | Policies, budget, and connectors | `policies-connectors` | 6 | 120 |
| Platform owner | Providers and connections | `provider-setup` | 4 | 67 |
| Platform owner | Review workspace search readiness | `search-index` | 2 | 43 |
| Platform owner | Set up the first workspace | `owner-first-workspace` | 5 | 104 |
| Platform owner | Single sign-on setup | `sso-setup` | 4 | 58 |
| Platform owner | SSO provisioning and go-live | `sso-security` | 4 | 87 |
| Platform owner | Users and role boundaries | `users-roles` | 4 | 58 |

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
| Model requests, saved work, schedules, search, and current console detail | `capture-training-refresh.cjs` |
| Forever defaults, source labels, sensitive-data review, holds, and policy previews | `capture-retention-governance.cjs` |
| Already validated provider card with its key vault closed | `capture-owner-provider-readiness.cjs` |

The auth lifecycle requires `CAPTURE_AUTH_MUTATION_CONFIRMATION=I_APPROVE_SYNTHETIC_AUTH_MUTATIONS` and a new private recovery-state file. The refresh script requires isolated synthetic role sessions, stages complete hash-checked batches, and leaves publication to review; its header documents the selected modes. First-owner capture requires an empty isolated API with demo/owner seeds disabled, a private owner fixture, and `CAPTURE_MUTATION_ACK=isolated-synthetic`; relogin mode checks persistence after a controlled isolated restart. Issue submission requires its explicit one-report acknowledgment and a new receipt. Use `CAPTURE_ISSUE_ID` to review that exact saved report. Read-only support scripts do not create missing ratings or reports.

SSO footage depends on actual service policy. The editable `sso-form.png` must come from an isolated fixture that really permits delegated administration; the restricted state uses `sso-readonly.png`. Preserve the main policy and never use one state as evidence of the other's controls. `users-actions.png` similarly records a real horizontal scroll to expose account actions at the capture viewport.

Baseline scripts stage complete batches under ignored `tmp/training-captures/` before copying declared frames to public assets; failed batches retain the prior files. Auth and support captures remain in review storage until publication. Inspect every image before release for synthetic data, hidden secrets, hover tooltips, current styling, and the narrated controls. Retain image hashes and measured targets together.

Retention captures require owner/admin synthetic session files, an inactive Forever policy, a configured synthetic source, and a matching saved conversation. The script allows scan and preview requests only; it does not save a finite policy or delete records. It stages ten frames per role under `tmp/retention-capture/` with centered, measured targets for review before publication. Both consoles group retention under Audit → Data Retention, with Schedule and rules and Tags and holds views. The two retention lessons start with a measured Audit-tab navigation shot and a written sidebar-link checklist. Location captions identify the view and control, and arrows target the actual source-entry fields, duration slider, label actions, hold form, and Preview/Save buttons. They teach review of suggested labels, explicit activation, minimum review periods, and the limits of chat-only cleanup.

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

## September 2026 coverage refresh

The refresh follows the current user, administrator, and platform-owner interfaces, including the matching interactive website guide. The owner Documentation header now includes **Interactive platform guide** as its third help destination, linking to `https://aperturechat.com/guide.html`.

| Current behavior | Walkthrough coverage | Written guidance |
| --- | --- | --- |
| Authenticator enrollment, verification at sign-in, recovery, and local password changes | `account-security`; owner SSO boundary guidance | All role PDFs; website account security and sign-in |
| Model availability, access requests, default stars, administrator decisions, and owner catalog policy | `model-access`, `admin-model-requests`, `policies-connectors` | All role PDFs; website role-specific model access |
| Saved drafts, history previews, archived work, unsynced work, and document layout | `save-and-recover-work`, `drafts`, `deck-basics` | All role PDFs; website Drafts and recovery |
| Search results, Recent, commands, route links, and index readiness | `search-and-commands`, `search-index` | All role PDFs; website search and owner indexing |
| Resources, reply settings, streaming, agent selection, and estimated versus reported context | `composer-commands`, `send-options`, `session-details`, `agents` | All role PDFs; website chat, Resources, and context |
| Theme schedules, scheduled automation timing, mobile navigation, and Help | `account-mobile-help`, `scheduled-automations` | All role PDFs; website appearance, automation, and mobile |
| Provider validation, catalog sync, enabled models, and group grants | `provider-setup`, `users-roles` | Owner PDF; website provider and access guidance |
| Conditional memory controls, visible tag chips, branding actions, and CSV export | `admin-policies`, both retention lessons, `branding`, analytics and audit | Administrator/owner PDFs; website governance and operations |

Captures use isolated synthetic accounts. The authenticator lifecycle was exercised through actual enrollment, subsequent verification, recovery, and session revocation; secrets were masked in published frames. Updated connected-model captures used a real validated local model. Tagging examples contain explicitly synthetic manual tags. Configuration screenshots do not claim that scheduled automations, external connectors, or SSO authentication have completed an end-to-end run.

## Current verification

The September 16, 2026 review rendered all **219 scenes** and inspected every lesson, with follow-up native-size checks for corrected captures and callouts. All **126 PDF pages** were rendered and visually checked; all fonts are embedded, contents links resolve, and the two copies of each guide are byte-identical.

Browser integration covered **12 role, viewport, and theme combinations**: user, administrator, and owner at desktop and phone widths in light and dark mode. All **49 signed-in library entries** were present and reachable; the separate pre-sign-in walkthrough remains available. Representative playback, seeking, transcripts, back/close controls, and phone fullscreen passed without page or media errors. All **50 MP3 tracks** decoded with nonzero audio and matched their scene timelines. All three actual UI downloads matched the generated PDFs. Relative PDF links now resolve correctly from nested console routes, and the phone player stays inside its viewport.

The interactive website guide was checked across **90 topics, three viewport widths, and two themes** (540 topic renders), including search, progress, navigation, and printing. Website publication is a separate operation from editing that repository.

The application build, full web suite, training inventory, focus coverage, capture/import tests, and narration-generator tests pass. Repeat the commands above after changing these sources. Audio decoding and timing checks are technical verification; they do not substitute for editorial listening.

The September 17 location review refreshed the Audit and Policies captures, added explicit Audit navigation to both retention lessons, regenerated the four affected narration tracks, and reviewed 39 scenes across the six affected lessons. Source fields, the duration slider, preview/save actions, CSV export, and connector configuration use measured control targets. Title cards, captions, and highlighted controls were checked for clipping and overlap.

## Owner console navigation review — September 17, 2026

The dedicated Setup tab and its four-scene lesson have been retired. Existing links resolve to Org Settings, and the first-run model action opens Providers. General configuration advice remains in the role documentation libraries and interactive platform guide. The owner PDF and local website guide describe the six current tabs.

The remaining owner library contains 14 lessons and 64 scenes. Four screenshots were recaptured from the isolated synthetic app; five focus regions were remeasured against those exact images. Providers and connections and Users and role boundaries received new narration. All 64 owner scenes were rendered with no clipped title cards or overlaps between title cards, captions, and highlighted controls. Earlier owner scenes received explicit overlay placement where needed.

The current complete catalog contains 49 lessons and 49 MP3 tracks (48 signed-in entries plus the pre-sign-in walkthrough). All media and PDF-copy checks pass. Legacy navigation, the 14-lesson owner library, and desktop/phone layouts were checked in light and dark themes.

## Sidebar redesign refresh — September 23, 2026

The sidebar now lists Search, Drafts, Agents, and Library below New chat. Chat history sits under a collapsible CHATS heading with folder, Pinned, and Recent groups, and each chat row has a single ⋯ menu. Admin console and Platform console links, Help, and the appearance buttons sit at the bottom, and unread markers follow a read position saved to the account. The training library was refreshed to match.

- **Screens:** 133 published screenshots were recaptured from the isolated synthetic app and two were added (`sidebar-chat-menu.png`, `sidebar-chats-hidden.png`). The chat fixtures behind them were created through the real UI with a local model, so every reply shown is genuine. Twelve frames were kept unchanged: `chat-images.png` and `chat-images-download.png`, which need a live image-generation provider, and the ten `deck-*` frames that carry generated slide imagery. Those two chat frames still show the earlier sidebar; the deck frames show only the collapsed rail.
- **Lessons:** Organize and find your work gained a sixth scene, Hide your chat list, and teaches the ⋯ menu for pinning, moving, and archiving. All three libraries and guides use the current Agents, Library, Admin console, and Platform console labels.
- **Narration:** six tracks were regenerated (`tools-automations`, `scheduled-automations`, `organize`, `account-mobile-help`, `admin-users`, `admin-tools`). Each was transcribed with speech recognition and compared with its script.
- **Focus and layout:** 220 focus regions were imported against the exact published PNG bytes. All 224 scenes were rendered through the training composition, measured for overlap between title cards, captions, and highlighted controls, and reviewed visually. Four scenes received explicit callout placement: both Search palette scenes, the problem-report form, and the temporary-password dialog. The Connections scenes highlight the Chat output actions header. Review corrected two owner frames: Policy Controls is now scrolled into view, and the retention tags frame shows a filtered scan with a suggested label.
- **Guides:** the three PDFs were regenerated (28, 42, and 58 pages), every page was rendered with Poppler and inspected, and each pair of copies is byte-identical.
