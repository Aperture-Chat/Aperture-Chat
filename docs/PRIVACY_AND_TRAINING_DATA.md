# Personal data protection and training datasets

Both features are off by default. No installation or migration turns either on.
Owners and tenant admins configure them per organization in the Admin console.

## Personal data protection

Admin → Policies → Personal Data Protection conceals personal data. When it is
on, each detected value is replaced with a typed placeholder such as `⟦SSN⟧` or
`⟦CARD NUMBER⟧` before the record is stored or shown. The chat shows these
placeholders as locked chips. Coverage:

- Chat messages, titles, regenerated answers, and activity traces. The store
  conceals every chat save, so the client adopts the concealed copy. The
  stream also returns the concealed prompt right away.
- Model replies, both JSON and streamed. Streaming holds back a short tail
  (`StreamingConcealer`) instead of buffering the whole answer.
- User Prompt Activity, chat feedback notes and previews, security alert
  snippets, retention tags, memories, issue reports, search results, and the
  Elastic export.
- Chats saved before protection was turned on are concealed whenever they are
  shown or exported. They are stored concealed the next time they are saved.

**Hide values from the model too** is on by default. Typed prompts and attached
file text are then concealed before the provider call, so the model sees only
the placeholder. Turn it off when the work needs the model to read the value
(for example, filling a form). The value is still concealed everywhere it is
stored or shown.

Administrators choose the categories to conceal:

- government IDs (SSN, ITIN, passport, driver's license, date of birth, VIN);
- contact details (email, phone, street address);
- financial accounts (card, bank account, ABA routing, IBAN);
- health identifiers (medical record, health plan member ID, Medicare MBI);
- secrets (private keys, API keys and tokens, disclosed passwords);
- network identifiers (IP addresses).

Detection is deterministic and runs inside the deployment (`app/core/personal_data.py`).
Regular expressions find candidates, and checksums or ranges reject look-alikes:
Luhn plus issuer prefix for cards, SSA ranges for SSNs, ABA, IBAN mod-97, and the
VIN check digit. Matching runs on a normalized copy of the text, so zero-width
characters, full-width digits, and Unicode dashes cannot hide a value.

Limits: detection does not recognize names or free-text descriptions of health
conditions. Drafts are documents of record and are not rewritten. Uploaded files
are stored as uploaded. Only the text extracted for the model is concealed.

### Hardening of existing controls

The same engine now backs the earlier pattern-based controls:

- **Content filters.** The built-in PII/HIPAA preset adds ITIN, international
  phone, street address, passport, driver's license, Medicare MBI, VIN, and IP
  address rules. Rules can declare a `validator` (`luhn`, `ssn`, `aba`, `iban`,
  `vin`, `has_digit`) that must accept the match or its named `value` group. The
  Financial preset's card and routing rules are now checksum-verified.
- **Evasion.** Filters match on the normalized copy, so look-alike characters
  cannot slip a value past a rule.
- **Attachments.** Attached file text is screened by the model's input filters.
  Before this change it reached the model through the runtime prompt without
  any screening.
- **API streams.** Streaming `/v1/chat/completions` responses now pass through
  output filters and concealment. Tool-call deltas pass through unchanged.
- **Alerts, tagging, and memory.** DLP alerts and sensitive-data retention
  tagging use the shared validators. Memory refuses candidates that contain
  identity, financial, health, or credential data, or a concealment token.

## Training datasets

Admin → Datasets keeps a private, de-identified record of how people rate and
correct answers, for later fine-tuning of an open-weight model. Model providers
stay under zero data retention, and captured examples are never sent to a
provider.

### Capture

When capture is on, saving or rating a chat records these signals:

- **Rated helpful / unhelpful**: a thumbs rating, with any note.
- **Corrected**: the next turn pushes back. The detector is deterministic: a
  factual correction such as "that's wrong, the deadline is 30 days" scores
  higher than a style revision such as "make it shorter". A regeneration also
  counts. The judged answer becomes the rejected response. The reply that
  followed becomes the preferred one, unless it was rated down or corrected
  again.

Every captured text is concealed with all categories, whatever the chat-time
policy is. By default, full names of workspace people and configured client and
matter names are concealed too. Chats tagged sensitive or regulated (confirmed
or suggested) and members of excluded groups are never captured. Examples
follow their chat: deleting a chat, a retention purge, or deleting a user or
tenant removes its examples. **Scan existing chats** captures signals from chats
saved before capture was on.

### Routing

Each example is labeled when it is captured:

- **Practice area.** Taken from the chat's retention subject tag when subject
  tagging is on. Otherwise a transparent keyword classifier maps the person's
  own words onto the same taxonomy, such as `legal/litigation` or `financial/tax`.
- **Kind of work.** Drafting, review, research, summarization, and so on.
- **Department.** The person's non-default groups.

A dataset is a set of routing rules (signals, practice areas, kinds of work,
departments, models; empty means any) plus a format. Membership is computed,
so editing a rule re-routes every example. One example can feed several
datasets. The console suggests datasets for practice areas and departments
that have examples but no dataset yet.

### Review and export

New examples wait for approval unless review is turned off. A download is a
ZIP containing:

- `train.jsonl` in the dataset's format:
  - `sft`: chat `messages` that end in the approved or revised answer;
  - `preference`: TRL/DPO `prompt`, `chosen`, `rejected`;
  - `kto`: `prompt`, `completion`, and a boolean `label`.
- `metadata.jsonl`, line-aligned labels with no user identity.
- `README.md`, a dataset card.

Identical content captured twice (for example, from a forked chat) is exported
once. Every download is recorded as `training.dataset_exported`.

## API

| Method and path | Purpose |
| --- | --- |
| `GET/PATCH /api/admin/privacy/policy` | Personal-data policy |
| `GET /api/admin/privacy/detectors` | Detector catalog (no data) |
| `POST /api/admin/privacy/preview` | Dry run on sample text; not stored |
| `GET/PATCH /api/admin/training/policy` | Capture policy |
| `GET /api/admin/training/overview` | Counts, work mix, suggestions, datasets |
| `GET /api/admin/training/taxonomy` | Practice areas, kinds of work, formats |
| `POST/PUT/DELETE /api/admin/training/datasets[/{id}]` | Dataset definitions |
| `GET /api/admin/training/examples` | Filterable examples (`status`, `signal`, `dataset_id`, `practice_area`, `unrouted`) |
| `POST /api/admin/training/examples/review` | Approve, exclude, or return to review |
| `POST /api/admin/training/scan` | Capture from existing chats, one page per call |
| `GET /api/admin/training/datasets/{id}/export` | ZIP bundle (`include_pending` optional) |

Tenant admins see and export only the examples of people they can already audit
in User Prompt Activity, so a tenant admin never reads another administrator's
conversations.

## Training

The narrated lessons are *Protect personal data* (`admin-personal-data`) and
*Build training datasets from ratings and corrections* (`admin-training-datasets`)
in the Admin console Documentation library, and *Personal data in your chats*
(`personal-data`) in Help. The user, administrator, and owner PDF guides have
matching sections, and the website guide has matching topics. See
[TRAINING.md](TRAINING.md) for how they were captured.
