# Coach-mark coverage

Every feature a person can reach in the app, and whether a guided tour
explains it yet. This is the working list for growing the coach marks over
time: pick a row marked **None**, add anchors to its components
(`useCoachAnchor` in `apps/web/components/coach-marks/anchor.tsx`), write the
tour in `apps/web/lib/coach-marks/tours.ts`, and move the row to **Covered**.

`apps/web/lib/coach-marks/coverage.test.ts` reads this file: every tour in
the registry must appear in the Tour column, and every id in that column must
exist in the registry, so the list cannot drift from the code.

Status: **Covered** — a tour walks through it. **Partial** — a tour mentions
it in passing (a step in the welcome tour, say) but nothing walks through it.
**None** — no tour touches it.

## Workspace

| Feature             | Where                        | Audience | Tour            | Status  |
| ------------------- | ---------------------------- | -------- | --------------- | ------- |
| Home feed           | `/[slug]`                    | everyone | `welcome`       | Covered |
| Agents list         | `/[slug]/agents`             | everyone | `agents`        | Covered |
| Agent builder       | `/[slug]/agents/new`, `edit` | everyone | `agent-builder` | Covered |
| Agent runs          | `/[slug]/agents/[id]/runs`   | everyone | `agent-runs`    | Covered |
| Agent page, sharing | `/[slug]/agents/[id]`        | everyone | `agent-detail`  | Covered |
| Knowledge search    | `/[slug]/knowledge`          | everyone | `knowledge`     | Covered |
| Files               | `/[slug]/files`              | everyone | `files`         | Covered |

## Chat

| Feature                      | Where                   | Audience | Tour                                 | Status  |
| ---------------------------- | ----------------------- | -------- | ------------------------------------ | ------- |
| Composer, tools, model, send | `/[slug]/chat/[id]`     | everyone | `chat`                               | Covered |
| Attachments                  | composer                | everyone | `chat-composer-more`                 | Covered |
| Prompt picker (`/`)          | composer                | everyone | `chat-composer-more`                 | Covered |
| Voice mode and dictation     | composer                | everyone | `chat-composer-more`                 | Covered |
| Compaction (`/compact`)      | thread                  | everyone | `chat-composer-more`                 | Partial |
| Tool permission asks         | thread                  | everyone | `chat-permission`                    | Covered |
| Sharing a chat               | thread title bar        | everyone | `chat-composer-more`                 | Covered |
| Projects                     | `/[slug]/chat/projects` | everyone | `projects`, `project`                | Covered |
| Code projects                | `/[slug]/code`          | everyone | `code`, `code-new`                   | Covered |
| Prompt libraries             | `/[slug]/chat/prompts`  | everyone | `prompt-libraries`, `prompt-library` | Covered |
| Memory                       | `/[slug]/chat/memory`   | everyone | `memory`                             | Covered |

## Account menu

| Feature         | Where                   | Audience | Tour            | Status  |
| --------------- | ----------------------- | -------- | --------------- | ------- |
| Notifications   | `/[slug]/notifications` | everyone | `notifications` | Covered |
| Preferences     | `/[slug]/preferences`   | everyone | `preferences`   | Covered |
| Connectors page | `/[slug]/connectors`    | everyone | `connectors`    | Covered |
| Tutorials       | `/[slug]/tutorials`     | everyone | `tutorials`     | Covered |
| Batch jobs      | `/[slug]/batch-jobs`    | everyone | `batch-jobs`    | Covered |
| Tools (usage)   | `/[slug]/usage`         | everyone | `tools-usage`   | Covered |
| My usage        | `/[slug]/utilization`   | everyone | `my-usage`      | Covered |
| Activity        | `/[slug]/logs`          | everyone | `activity`      | Covered |
| About           | `/[slug]/about`         | everyone | `about`         | Covered |

## Connecting a connector (as yourself)

The connectors tour covers the page — Add connector and the MCP endpoint —
but no tour yet walks through connecting one product. Each of these is a
card on `/[slug]/connectors`; a tour per card would add anchors to the card's
connect button and any per-product options.

| Connector               | Notes                                           | Tour | Status |
| ----------------------- | ----------------------------------------------- | ---- | ------ |
| Jira                    | Atlassian OAuth; scope picker                   | —    | None   |
| Jira Service Management | shares the Atlassian grant                      | —    | None   |
| Confluence              | Atlassian                                       | —    | None   |
| Bitbucket               | Atlassian                                       | —    | None   |
| Outlook                 | Microsoft; indexing preferences                 | —    | None   |
| SharePoint              | Microsoft                                       | —    | None   |
| OneDrive                | Microsoft                                       | —    | None   |
| WebEx                   | Integration OAuth; "Watch all my spaces"        | —    | None   |
| Zoom                    | OAuth                                           | —    | None   |
| OnBase                  | tenant IdP, PKCE                                | —    | None   |
| File shares             | per-share credentials                           | —    | None   |
| Mirth Connect           | per-instance account                            | —    | None   |
| Sandbox secrets         | on the connectors page when a sandbox is set up | —    | None   |

## Organization console (operators)

| Feature                 | Where                           | Tour    | Status  |
| ----------------------- | ------------------------------- | ------- | ------- |
| Console overview        | `/[slug]/admin`                 | `admin` | Covered |
| Connector setup         | `/[slug]/admin/connectors`      | —       | None    |
| File shares             | `/[slug]/admin/file-shares`     | —       | None    |
| Mirth Connect instances | `/[slug]/admin/mirth`           | —       | None    |
| Sites                   | `/[slug]/admin/sites`           | —       | None    |
| Models                  | `/[slug]/admin/llm-models`      | —       | None    |
| Storage                 | `/[slug]/admin/storage`         | —       | None    |
| Agent oversight         | `/[slug]/admin/agents`          | —       | None    |
| Holiday calendars       | `/[slug]/admin/calendars`       | —       | None    |
| Organization usage      | `/[slug]/admin/usage`           | —       | None    |
| Sensitive data          | `/[slug]/admin/redaction`       | —       | None    |
| Email sanitizer         | `/[slug]/admin/email-sanitizer` | —       | None    |
| Settings                | `/[slug]/admin/settings`        | —       | None    |
| Access                  | `/[slug]/admin/access`          | —       | None    |
| Audit                   | `/[slug]/admin/audit`           | —       | None    |
| Events                  | `/[slug]/admin/events`          | —       | None    |
| Tutorials report        | `/[slug]/admin/tutorials`       | `admin` | Partial |
