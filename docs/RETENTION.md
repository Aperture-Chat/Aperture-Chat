# Chat retention and classification

Chat retention starts at **Forever**, with automatic deletion disabled. Existing
policies created before automated chat enforcement remain inactive until an
administrator explicitly enables it. No installation or migration enables it.

Owners and tenant admins configure retention under Audit → Data Retention.
Schedule and rules contains the policy and classification settings. Tags and
holds contains conversation search, label review, legal holds, and batch actions.
User Prompt Activity is a separate panel for inspecting saved exchanges. The presets are 1, 5, 7, 10 years, and Forever
(one year is 365 days). Moving the slider edits a draft. Preview effect counts
all saved chats in the tenant; Save applies that exact previewed policy.
Concurrent policy or candidate changes require another preview.

## Eligibility and policy changes

Choose chat creation or the last message change as the clock. Metadata changes
such as rename, pin, folder change, and archive do not reset the activity clock.
The longest matching rule wins. A matching Forever rule and legal holds prevent
automatic deletion. With “only labels with a rule,” unmatched chats remain
indefinitely. Matter retention metadata is a minimum floor, not a deletion trigger.

Shortening the duration recalculates existing chats; increasing it extends their
eligibility dates. Nothing can restore already deleted data. Eligible chats receive
at least seven days for review, and saving a changed policy restarts the window.
Choosing Forever disables automatic deletion immediately. A background scheduler
checks current saved policies and authoritative clocks, holds, and tags before
each deletion. Pending review records cannot starve later eligible records.

## Identity and review

Configure stable client, matter, or regulated-record identities with names and
aliases. Matching is case-insensitive, Unicode-normalized, and word-bounded.
Names and aliases suggest identities; administrators must confirm a label before
it can drive identity-based deletion. Several matching identities may apply to
one chat, and their strongest preservation requirement wins. Explicit matter links
are also authoritative policy inputs.

Scan existing chats processes all saved chats in pages, not just the visible
first page. New saved messages are scanned again, so later mentions are included.
Dismissals persist so the same candidate does not immediately reappear. Confirmed
labels include actor, date, namespace, and stable key; policy, scan, review, hold,
and deletion actions are audited. Suggestions never copy matched PII values.

Sensitive-data suggestions recognize email addresses, formatted US Social
Security-number candidates, and Luhn-valid payment-card candidates in saved text.
This is limited pattern detection, not a determination of legal applicability.
It can miss data or produce false positives. Original attachments, images, OCR,
external sources, and unsaved content are not scanned. A human can explicitly
assign a configured regulated-record category even when no pattern matched.
The existing model-generated subject label is informational and cannot alone
trigger a subject retention rule. Factual MCP/upload tags remain available.

## Holds and cleanup scope

Named legal holds cover selected chats and block both automated and ordinary
chat deletion. Release is tenant-scoped and explicit. Release starts a new review
window. To preserve future chats for a client, also apply a Forever rule to its
confirmed identity. Holds do not automatically expand to newly mentioned clients.

Automatic cleanup removes the chat, linked uploads/image previews, search entry,
chat feedback, tags, and released hold membership. An atomic content-free deletion
ledger prevents a stale workspace save from restoring the same chat ID. An audit
event and its delivery outbox entry commit with the deletion.

Uploads still referenced by another saved chat are preserved and assigned to
that surviving chat for later cleanup, including when the surviving chat is held.
This protection applies to both automatic cleanup and ordinary chat deletion.

Drafts, saved memories, audit/usage histories, generated-media files, independent
attachments, exports, backups, and provider/connector copies are separate data
stores with separate policies. This feature does not claim complete client
erasure across those stores. Scheduler availability determines cleanup timing;
expired records may be processed over multiple bounded passes.

The duration is an organization's decision; seven years is a selectable preset,
not a universal legal rule. The [FTC's data protection guidance](https://www.ftc.gov/business-guidance/resources/protecting-personal-information-guide-business)
explains why retention schedules should identify what is kept, for how long, and
how it is disposed of. Preservation taking precedence over deletion is also
reflected in [Microsoft's retention principles](https://learn.microsoft.com/en-us/purview/retention).
