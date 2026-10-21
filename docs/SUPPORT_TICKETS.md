# Support Tickets and the Community Hub

People report problems, ideas, questions, feedback, and security concerns from
**Help › Report a problem**. Each report becomes a ticket that administrators
work in the **Reports** tab and that the reporter follows in **Help › My
reports**. A platform owner can also share a redacted copy with the Aperture
Chat maintainers, who track it as a GitHub issue on the project repository.
Its status then flows back to the ticket. No deployment needs a GitHub account
or token for this.

## Reporting

The report form asks for a type, a subject, and a message. Problems also ask
for impact ("Blocking me", "Slows me down", "Minor"). Reporters can
attach one screenshot: choose a file, paste one, drop one, or use **Capture
screen** in browsers that support screen capture.

**Include technical details** is on by default and shows exactly what it
adds. That is the page path, window size, theme, language, time zone, browser
user agent, the last few error messages, and the method, path, and status of
recent failed API calls. The server adds the app version and the reporter's
role. Request and response bodies and chat content are never attached.
Unfinished drafts survive closing the drawer for the rest of the browser
session.

Each organization numbers its tickets (#1, #2, …). Subjects, messages, and
replies follow the organization's personal-data protection policy.

## Working tickets

The **Reports** tab is in the Admin console and the Platform console. Tenant
admins see tickets from the people they administer, never another admin's or
the owner's. Platform owners see every organization's tickets.

| Status | Meaning for the reporter |
| --- | --- |
| Received | Sent and waiting for review. |
| In review | Someone is looking at it. A first public reply moves a ticket here. |
| In progress | Being worked on. |
| On hold | Paused, for example waiting on a release or a decision. |
| Resolved | Fixed or answered. The reporter can reopen it. |
| Closed | Closed without further work. The reporter can reopen it. |

Admins can set status, priority (Low, Normal, High, Urgent), type, and
assignee, reply publicly, or add internal notes that reporters never see.
**Needs reply** lists open tickets where the reporter spoke last. Every change
is audited under `support.*`.

Reporters see public replies (signed "Support team"), status changes, and
GitHub progress in **My reports**. A dot on **Help** marks reports with news.
They can reply while a ticket is open and reopen it once it is resolved or
closed.

To email administrators about new tickets, use the **Support-reports
template** in **Alerts**. It watches `support.issue_reported`,
`support.issue_reporter_replied`, and `support.issue_reopened`. When SMTP is
configured, reporters are also emailed about public replies and status
changes. Owners can turn this off in Reports › Settings.

## Sharing with the maintainers

Owners choose a mode in **Platform console › Reports › Settings**:

| Mode | Behavior |
| --- | --- |
| Review each report (default) | Nothing leaves until an owner opens **Share with maintainers**, reviews or edits the redacted text, and sends it. |
| Share automatically | New tickets, except security concerns, are redacted and queued for the hub. With a support assistant model, AI rewrites each one first as an extra privacy pass. |
| Off | Tickets stay on the deployment. |

Before anything is sent, the deployment applies its redaction rules, and the
hub applies them again on arrival. Personal data such as email addresses, phone
numbers, identifiers, credentials, and IP addresses becomes typed placeholders
like `⟦EMAIL⟧`. Placeholders also replace:

- the names of people and organizations on the deployment;
- links, except github.com and aperturechat.com;
- the deployment's own hostnames and private hostnames;
- home-directory paths;
- long token-like strings.

Diagnostics are reduced to version, area of the app (IDs removed), browser and
OS family, window size, theme, role, and redacted error lines. Screenshots
never leave the deployment.

Security concerns are never shared. The share dialog points to a private GitHub
security advisory instead. Every share dialog also offers a prefilled GitHub
issue link, which works without any hub.

The deployment identifies itself to the hub only by a random instance ID.
After a share, the scheduler polls the hub with a per-report receipt token and
posts timeline entries the reporter can read: tracked as issue #N, closed as
completed, closed as not planned, reopened, or declined with a note. Failed
sends retry with backoff (1 minute up to 1 day, 8 attempts), and owners can
**Retry now**.

| Setting | Purpose |
| --- | --- |
| `APERTURE_SUPPORT_HUB_URL` | Hub to share with (default `https://chat.aperturechat.com`). Blank turns hub sharing off. |
| `APERTURE_SUPPORT_HUB_TIMEOUT_SECONDS` | Outbound request timeout (default 15). |
| `APERTURE_SUPPORT_HUB_POLL_INTERVAL_SECONDS` | How often a shared ticket refreshes its status (default 3 hours). |

Outbound calls go through the egress guard and never follow redirects.

## Running the hub

The project's own deployment runs the hub. A fork can run its own and point
its deployments at it with `APERTURE_SUPPORT_HUB_URL`.

1. In **Platform console › Reports › Settings › Community hub**, turn on
   **Accept reports from other deployments**.
2. Set the repository as `owner/name` (default: the update-check repository).
3. Paste a fine-grained personal access token limited to that one repository
   with **Issues: Read and write**. It is stored in the encrypted vault, shown
   only masked, and can be checked with **Check GitHub access**.
4. Optionally choose a **Support assistant** model for AI triage, and turn on
   **Publish clean reports automatically**.

Incoming reports wait in **Reports › Community hub**. Triage searches GitHub for
likely duplicates and, with a model, summarizes the report and suggests a
title, labels, and severity. It also estimates spam likelihood and flags
security-sensitive or personal content. A maintainer then publishes a new
issue (labeled `in-app report` plus the chosen labels), adds the report as a
comment on an existing issue, or declines it (optionally as spam). A decline
note is redacted and sent back to the reporting deployment. Security reports
are held privately and can never be published. Auto-publish files only
reports that triage found clean: no spam, sensitive data, security content, or
likely duplicate.

The public API answers only while the hub is on:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/support-hub/v1/info` | Whether the hub accepts reports, and for which repository. |
| `POST /api/support-hub/v1/reports` | Submit a redacted report; returns an ID and a receipt token. |
| `GET /api/support-hub/v1/reports/{id}` | Status for the holder of `Authorization: Bearer <receipt>`. |

Abuse controls:

- Durable limits per sender address (10 per hour, 30 per day) and per
  deployment (20 per hour, 60 per day).
- A burst limiter on every endpoint.
- A cap of 1,000 pending reports.
- Strict request shapes.
- Neutralized markdown: no raw HTML, `@mentions`, or `#123` references reach
  GitHub.
- The hub stores only SHA-256 hashes of receipt tokens and of sender
  addresses (salted per hub).

Published issues are re-read from GitHub hourly
(`APERTURE_SUPPORT_HUB_GITHUB_SYNC_INTERVAL_SECONDS`) or on demand with **Sync
GitHub status**.
