# Training content and publication

Training ships with the web application. Help opens the user library; Documentation in each console opens its role library. These are browser-rendered narrated walkthroughs assembled from captured PNGs, MP3 narration, captions, transcripts, and scene timelines. They are not standalone MP4 files.

## Current inventory

The training set contains **53 lessons, 545 scenes, 53 MP3 tracks, and 7,662 seconds of narration timelines (127 minutes 42 seconds)**. Its 491 measured focus-map entries comprise 200 user targets and 291 administrator/owner targets. Scene counts and reusable focus-map entries are counted independently.

| Audience | Lessons | Scenes | Measured focus entries | MP3s | Seconds | Guide sections |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| User | 22 | 211 | 200 | 22 | 2644 | 26 |
| Administrator | 13 | 137 | 133 | 13 | 1823 | 40 |
| Platform owner | 18 | 197 | 158 | 18 | 3195 | 59 |
| Total | 53 | 545 | 491 | 53 | 7662 | — |

All three downloadable guides have byte-identical copies in `apps/web/public/docs/` and `docs/`: `aperture-user-guide.pdf`, `aperture-admin-guide.pdf`, and `aperture-owner-guide.pdf`. The 26/40/59 section counts are role-filtered: administrator guides include user sections, and the owner guide includes both user and administrator sections.

Lesson counts and timings below are generated from the TypeScript catalog with `--include-drafts`; focus maps, MP3 counts, guide sections, and PDF-copy equality are checked separately. Including drafts inventories proposed content; it never publishes a lesson.

## Training methodology

Every lesson teaches one task as a complete loop: it starts where a person actually starts and ends at a result they can see. A lesson is a narrated video and a written guide built from the same source, so the two cannot drift apart. The same structured guidance also feeds the downloadable PDFs and the website guide.

### Lesson anatomy

Each lesson object in `apps/web/src/components/trainingDecks/{user,admin,owner}.tsx` carries:

| Field | Purpose |
| --- | --- |
| `track` | Curriculum heading. Libraries group lessons under their track, in deck order. |
| `title`, `description` | The task, in the learner's words, and what they will be able to do. |
| `outcomes` | Two to four observable results, shown as chips under the video. |
| `prerequisites` | Role or permission, prior setup, and any outside accounts or values. Shown as **Before you begin**. |
| `setupSteps` | The full numbered procedure for the primary path, one action per step, using exact on-screen labels and ending with verification. Shown as **Step by step**. |
| `paths` | Alternative routes through the same task (an identity provider, a provider kind, a delivery target, a device), each complete from start to finish. Shown as a path picker inside **Step by step**. |
| `verify` | What proves the task worked end to end. Shown as **Check it worked**. |
| `troubleshooting` | Real messages and symptoms, quoted from the product, each with its fix. Shown as **Troubleshooting**. |
| `scenes` | The video: one idea per scene, each tied to a measured control on a real capture or to an instruction card. |

Scenes follow a consistent arc: an optional opening checklist card, where to find the feature, one scene per step with the exact control highlighted, the verified result, and where useful a real error or refusal the learner may meet.

### Coverage

- **Complete loop.** No scene ends on "then configure it". Setup lessons finish on the evidence: the passing test, the saved item, the delivered email, the signed-in person.
- **Every path.** When the product offers alternative ways to do a task, each one is taught completely, either as its own lesson (substantial, vendor-specific paths such as Microsoft Entra ID, Okta, and Google Workspace sign-in) or as a `paths` entry with scenes wherever its screens differ.
- **Real messages.** Troubleshooting entries quote strings that exist in the product source, so a learner can match what they see.

### Evidence rules

- Every screenshot is a real state captured from an isolated instance with synthetic data. Screens are never staged, edited, or composited, and success is never simulated.
- **Instruction cards** (`card` scenes) are drawn by the video composition and are labeled with where the steps happen (for example "Do this in · Microsoft Entra admin center"). They are used only for steps outside the product, such as a vendor console or a phone's share sheet, and for opening checklists. They never imitate another product's interface.
- When a path cannot run locally (a paid vendor account, an image model), the lesson shows the real product state that can be produced, teaches the outside steps with a card, and says plainly what the learner will see. For example, the Entra and Okta presets are typed into the real form but not saved as working, while Google's public issuer is genuinely tested.
- Captures never contain filled password or one-time-code fields, authenticator QR codes, setup secrets, or recovery codes; the walkthrough runner refuses them.

### Narration and captions

Narration is second person, imperative, and present tense, and says each label exactly as it appears. Scenes run 8 to 25 seconds. Acronyms that text-to-speech misreads are spelled out in the narration ("S S O", "I D"), never in captions or guides. Captions summarize the scene in one sentence; the renderer check flags any caption, title card, or highlight that collides.

### Capturing a complete walkthrough

`apps/web/scripts/capture-walkthroughs.cjs` runs modules from `apps/web/scripts/walkthroughs/`. A module performs its task for real against an isolated instance (for SSO: register the application at a local Keycloak, save and test it in the console, sign a synthetic person in, map groups, and enforce), staging a frame at each step. At every `shot()` the runner measures the focus regions the deck declares for that frame from the live DOM, and writes `<role>/measured-rects.json` beside the PNGs for `apply-training-focus.cjs`. External origins such as the identity provider must be declared by the module; every other origin except the app's web font is blocked. `--publish` copies a complete, hash-checked batch into `public/training/<role>/`.

## Sources

| Source | Responsibility |
| --- | --- |
| `apps/web/src/components/trainingDecks/{user,admin,owner}.tsx` | Lesson content, setup steps, narration, timing, and measured frame targets. |
| `apps/web/src/components/TrainingVideoLibrary.tsx` | Role libraries, player, transcript, and guide downloads. |
| `apps/web/src/components/trainingVideoKit.tsx` | 1185 × 855 composition at 30 fps; image fit, highlights, callouts, and captions. |
| `apps/web/scripts/training-catalog.cjs` and `audit-training.cjs` | Inventory, media/timing checks, capture contracts, and PDF-copy checks. |
| `apps/web/scripts/capture-walkthroughs.cjs` and `walkthroughs/*.cjs` | Complete, path-by-path walkthroughs performed for real against an isolated instance, with measured focus regions. |
| `apps/web/scripts/training-focus-measurement.cjs` and `apply-training-focus.cjs` | DOM measurements and imports verified against the exact public PNG bytes. |
| `apps/web/scripts/training-frame-aliases.cjs` | Byte-identical onboarding views of reviewed model access, account management, and a genuine user reply. |
| `apps/web/scripts/generate-training-narration.py` | Per-scene speech, MP3 encoding, timing updates, and private build evidence. |
| `apps/web/scripts/guide-pdfs/{content,render,generate}.cjs` | Written guides, print layout, contents pagination, and matching PDF publication. |
| `apps/web/public/training/{user,admin,owner}/` | Served screenshots and narration. |
| `docs/images/` and `README.md` | Product overview screenshots and role-guide links. |

## Lesson inventory

Lessons are listed in each library's curriculum order. Seconds are the sum of each lesson's scene durations; Cards counts instruction-card scenes.

| Audience | Track | Title | Lesson ID | Scenes | Cards | Seconds |
| --- | --- | --- | --- | ---: | ---: | ---: |
| User | Get started | Request access and enter your workspace | `access-and-sign-in` | 16 | 2 | 230 |
| User | Get started | Start chatting | `chat-basics` | 8 | 0 | 98 |
| User | Get started | Choose models and request access | `model-access` | 8 | 0 | 118 |
| User | Get started | Protect your account and recover access | `account-security` | 12 | 1 | 171 |
| User | Chat | Symbol shortcuts: / @ # $ > | `composer-commands` | 11 | 0 | 109 |
| User | Chat | Knowledge, Web, Agent, and reply settings | `send-options` | 12 | 0 | 158 |
| User | Chat | Attach files and sources | `attachments` | 9 | 1 | 128 |
| User | Chat | Dictation, images, and diagrams | `dictation-images` | 6 | 0 | 87 |
| User | Chat | Follow the work trace and act on replies | `work-traces` | 8 | 0 | 103 |
| User | Chat | Session details and context | `session-details` | 4 | 0 | 59 |
| User | Chat | Preview chats at a glance | `chat-previews` | 2 | 0 | 34 |
| User | Drafts and decks | Draft documents | `drafts` | 17 | 0 | 214 |
| User | Drafts and decks | Build a slide deck | `deck-basics` | 15 | 0 | 165 |
| User | Drafts and decks | Save, organize, and recover your drafts | `save-and-recover-work` | 8 | 0 | 100 |
| User | Agents, knowledge, and automations | Agent profiles | `agents` | 9 | 0 | 112 |
| User | Agents, knowledge, and automations | Knowledge bases | `knowledge` | 10 | 0 | 123 |
| User | Agents, knowledge, and automations | Tools and the Library | `tools-automations` | 6 | 0 | 68 |
| User | Agents, knowledge, and automations | Scheduled automations | `scheduled-automations` | 15 | 0 | 162 |
| User | Organize and personalize | Organize and find your work | `organize` | 9 | 0 | 96 |
| User | Organize and personalize | Search, commands, and workspace links | `search-and-commands` | 7 | 0 | 80 |
| User | Organize and personalize | Personalization memory | `personalization-memory` | 7 | 0 | 88 |
| User | Organize and personalize | Personalize, use mobile, and get help | `account-mobile-help` | 12 | 1 | 141 |
| Administrator | Accounts and access | Approve access and finish sign-in | `admin-access-onboarding` | 17 | 1 | 209 |
| Administrator | Accounts and access | Users and accounts | `admin-users` | 12 | 0 | 156 |
| Administrator | Accounts and access | Groups and permissions | `admin-groups` | 10 | 0 | 125 |
| Administrator | Accounts and access | Tenant model access | `admin-model-access` | 8 | 0 | 111 |
| Administrator | Accounts and access | Review model requests and explain access | `admin-model-requests` | 8 | 0 | 97 |
| Administrator | Sign-in | Tenant SSO and provisioning | `admin-sso` | 20 | 2 | 294 |
| Administrator | Workspace controls | Policies and memory governance | `admin-policies` | 10 | 0 | 149 |
| Administrator | Workspace controls | Response actions and connector responsibilities | `admin-tools` | 12 | 0 | 150 |
| Administrator | Oversight and compliance | Tenant analytics | `admin-analytics` | 9 | 0 | 123 |
| Administrator | Oversight and compliance | Tenant audit | `admin-audit` | 7 | 0 | 93 |
| Administrator | Oversight and compliance | Alerts and delivery | `admin-alerts` | 8 | 1 | 111 |
| Administrator | Oversight and compliance | Data retention and tagging | `admin-retention` | 10 | 0 | 136 |
| Administrator | Oversight and compliance | Review feedback and reported issues | `admin-feedback-issues` | 6 | 0 | 69 |
| Platform owner | Get started | Set up the first workspace | `owner-first-workspace` | 13 | 1 | 232 |
| Platform owner | Get started | Providers and connections | `provider-setup` | 23 | 7 | 388 |
| Platform owner | Get started | API Key Vault and replacement | `api-key-vault` | 7 | 0 | 111 |
| Platform owner | Get started | Organization model availability | `model-availability` | 8 | 0 | 125 |
| Platform owner | People and access | Users and role boundaries | `users-roles` | 8 | 0 | 130 |
| Platform owner | Single sign-on | Single sign-on, start to finish | `sso-setup` | 20 | 1 | 326 |
| Platform owner | Single sign-on | Single sign-on with Microsoft Entra ID | `sso-entra` | 9 | 4 | 157 |
| Platform owner | Single sign-on | Single sign-on with Okta | `sso-okta` | 8 | 5 | 125 |
| Platform owner | Single sign-on | Single sign-on with Google Workspace | `sso-google` | 6 | 4 | 98 |
| Platform owner | Single sign-on | Go live: groups, MFA, and enforcement | `sso-security` | 7 | 1 | 128 |
| Platform owner | Policies and branding | Policies, budget, and connectors | `policies-connectors` | 24 | 5 | 394 |
| Platform owner | Policies and branding | Platform branding | `branding` | 8 | 0 | 118 |
| Platform owner | Policies and branding | Review workspace search readiness | `search-index` | 4 | 0 | 62 |
| Platform owner | Monitoring and compliance | Analytics: runtime, activity, and usage | `runtime-analytics` | 9 | 0 | 117 |
| Platform owner | Monitoring and compliance | Owner audit signals | `owner-audit` | 9 | 0 | 136 |
| Platform owner | Monitoring and compliance | Alerts and email delivery | `owner-alerts` | 12 | 3 | 209 |
| Platform owner | Monitoring and compliance | Elastic Analytics export | `elastic-analytics` | 12 | 2 | 184 |
| Platform owner | Monitoring and compliance | Data retention and tagging | `owner-retention` | 10 | 0 | 155 |

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
| Every lesson's complete walkthrough (current library) | `capture-walkthroughs.cjs` with the modules in `walkthroughs/` (one file per role and topic) |
| User chat and navigation | `capture-training-frames.cjs` |
| Deck editor, slide AI edit, uploaded background, presenter view, and brand template | `capture-deck-frames.cjs` |
| Document editor, Edit with AI review, slash menu, find and outline, settings, and history | `capture-training-refresh.cjs drafts` |
| Session details, its Symbol shortcuts list, and the five composer symbol menus | `capture-training-refresh.cjs symbols` |
| Admin and owner audit signals, Audit Insights, a chart drill-down, security alerts or prompts, and the trail | `capture-training-refresh.cjs audit` |
| Admin and owner alert email, both rule templates, the Only these detections form, and real deliveries | `capture-training-refresh.cjs alerts` |
| Owner Elastic Analytics connection, data streams, connection checks, and delivery | `capture-training-refresh.cjs elastic` |
| Drafts paperclip From this device menu and a synthetic file opened in the editor | `capture-training-refresh.cjs open` |
| Administrator console, policies, analytics, and audit | `capture-admin-frames.cjs`, `capture-admin-analytics-frames.cjs` |
| Owner configuration, connectors, usage, audit, and retention | `capture-owner-frames.cjs` |
| Account, Help, and mobile installation UI | `capture-user-support-frames.cjs` |
| Real request, approval, password, authenticator, recovery, and logout lifecycle | `capture-auth-onboarding-frames.cjs` |
| Actual first-owner bootstrap and welcome | `capture-first-owner-frames.cjs` |
| One authorized synthetic issue with a reviewed attachment | `capture-report-submission.cjs` |
| Existing feedback and the selected issue detail | `capture-admin-support-frames.cjs` |
| Actual policy-restricted SSO panel | `capture-admin-sso-readonly-frames.cjs` |
| Model requests, unsynced work, schedules, search, and current console detail | `capture-training-refresh.cjs` |
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

## Drafts editor refresh

The Drafts document and deck editor upgrade refreshed `drafts`, `deck-basics`, and the two Drafts frames in `save-and-recover-work`. `drafts` gained scenes for Edit with AI, the slash menu, and the status bar's outline, find, and zoom; `deck-basics` now teaches the Layouts and Themes strip, Deck starters & brand themes, Edit slide with AI, and presenter view. All three lessons were re-narrated; `save-and-recover-work` now points to the **Document history** button at the top of the assistant rail, because the composer's separate history button was removed. The user, administrator, and owner guides describe the same controls.

The document frames come from `capture-training-refresh.cjs drafts`, which types a synthetic checklist, saves it, and requests one real Edit with AI suggestion from the connected model before discarding it. `capture-deck-frames.cjs` converts a synthetic memo into slides, applies one real Edit slide with AI result, and uploads `fixtures/deck-background.jpg` (drawn by `fixtures/generate-deck-background.py`) as the user's own background. Both captures load the app's web font; every other outside origin stays blocked. The isolated instance had no image-generation model, so `deck-ai-image.png` was kept with `CAPTURE_KEEP_PUBLISHED_FRAMES=deck-ai-image`; it still shows the earlier toolbar and should be recaptured when an image model is available.

## Symbol shortcuts refresh

Session details now ends with a **Symbol shortcuts** list of the five message-box symbols (`/`, `@`, `#`, `$`, `>`). The `composer-commands` lesson was renamed **Symbol shortcuts: / @ # $ >** so the symbols show in the Help list, and it grew from four scenes to seven: where to find the list, one scene per symbol menu with real synthetic items, and the Resources browser. `session-details` gained a third scene for the new list. Both lessons were re-narrated and transcribed with speech recognition against their scripts.

`capture-training-refresh.cjs symbols` is read-only: it opens a saved synthetic chat, captures Session details at the top and scrolled to the list, then types each symbol into the composer without sending. It needs at least one saved prompt, agent profile, knowledge base, skill file, and automation, and it fails rather than capture an empty menu. It recaptured `chat-session-panel`, `composer-slash`, `composer-agent`, and `composer-hash`, and added `session-shortcuts`, `composer-skill`, and `composer-automation`. Other frames that show the Session details panel incidentally still show it without the new list. The written guides' symbol table now matches what each menu does, and their Session details section points to the list.

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

## Audit, alerts, Elastic, and Drafts refresh

The October 2026 interface changes refreshed five lessons and added one. `owner-audit` and `admin-audit` now teach the grouped signal board (the attention banner, Expand all, List and Cards), Audit Insights trends, and the investigation that opens from any chart mark or signal row. `owner-alerts` and `admin-alerts` cover the Prompt-injection template, the Only these detections filter, the SMTP relay guidance with verified TLS, and the rule that Send test email uses saved settings. The new owner lesson `elastic-analytics` walks through the Elastic Analytics connection, data streams, Save and check, the connection checks, delivery, and Kibana data views. `drafts` gained two scenes for the paperclip's From this device menu: Attach to chat versus Open in editor, and a file opened as a new draft. All six lessons were narrated with the same Kokoro voice, and the user, administrator, and owner guides describe the same controls.

Frames came from an isolated copy of the synthetic training fixture. Two weeks of back-dated synthetic audit events and security alerts were added so the trend charts have data; alert snippets came from the real DLP scanner run on synthetic prompts. Today's flagged prompts were real chats with the local training model, and their alert emails were really delivered over verified STARTTLS to a local SMTP relay trusted only through a private test CA. The Elastic frames show a real single-node Elastic cluster the panel was saved against, with an API key minted from the panel's own recommended request; the delivery counts are its actual sends. The opened document is a generated synthetic Markdown file.

- **Narration:** six tracks were regenerated (`owner-audit`, `owner-alerts`, `elastic-analytics`, `admin-audit`, `admin-alerts`, and `drafts`). Each was transcribed with speech recognition and compared with its script.
- **Focus and layout:** 33 focus regions were imported against the exact published PNG bytes. All 42 scenes of the changed lessons were rendered through the training composition, measured for overlap between title cards, captions, and highlighted controls, and reviewed visually. Eight scenes received explicit callout or caption placement so the card does not cover the control it describes.
- **Guides:** the three PDFs were regenerated (30, 45, and 62 pages), the changed pages were rendered with Poppler and inspected, and each pair of copies is byte-identical.

## Complete walkthrough overhaul — October 2026

Every lesson was rebuilt to the methodology above: a complete loop from the first click to a visible result, every path the product offers, and a written guide (Before you begin, Step by step with paths, Check it worked, Troubleshooting) beside the video. The libraries are grouped into curriculum tracks. The downloadable guides embed each lesson's procedure, and the website guide shows the same written guide under every video.

- **Single sign-on** became a five-lesson track. *Single sign-on, start to finish* performs the whole loop against a real Keycloak: realm, confidential client with PKCE, group mapper, groups, and a test person in the identity provider's console; then save, Test connection, a first sign-in that creates the account, and verification in Users. *Microsoft Entra ID*, *Okta*, and *Google Workspace* teach each vendor console with instruction cards checked against current vendor documentation, with the real Aperture Chat presets; Google's public issuer is genuinely tested. *Go live* maps groups and proves they sync, enforces SSO, and records the real refusals for a local password on an enforced domain and for an address outside the allowed domains. The administrator lesson repeats the loop through the Admin console SSO tab with its own realm.
- **Captures:** about 450 frames were captured by walkthrough modules on four isolated synthetic instances while each task was really performed, including real cloud-provider rejections, a real Kibana import, real SMTP deliveries to a local relay, and real budget refusals. Frames still current from earlier refreshes were kept only after comparison (masked authenticator screens, image-generation frames that need an image model, a few editor frames, and the two portrait phone frames). The 140 superseded frames and the onboarding frame aliases were retired.
- **Narration:** all 53 tracks were regenerated with the same Kokoro voice and transcribed with Whisper; every track matched its script (the two lowest word-agreement scores came from Whisper repeating text over trailing silence past the end of the audio).
- **Layout:** all 545 scenes were rendered through the composition and measured for overlap between title cards, captions, and highlights; flagged scenes received explicit placements, with one accepted 8% caption overlap on a full-height phone frame.
- **Guides:** the PDFs were regenerated (76, 113, and 167 pages) and every page was rasterized and inspected; each pair of copies is byte-identical.
- **Product fixes found by the walkthroughs:** the SSO panel showed a relative redirect URI in same-origin deployments, and the OIDC token exchange now prefers `client_secret_basic` with a one-time `client_secret_post` fallback, which Okta's per-app authentication method requires. Other defects found while recording are taught as they currently behave and are listed for follow-up rather than hidden.
