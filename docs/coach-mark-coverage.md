# Coach-mark coverage

Every feature a person can reach in the app, and whether a guided tour
explains it yet. This is the working list for growing the coach marks over
time: pick a row marked **None**, add anchors to its components
(`useCoachAnchor` in `apps/web/components/coach-marks/anchor.tsx`), write the
tour in `apps/web/lib/coach-marks/tours/<area>.ts`, and move the row to **Covered**.

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

The `connectors` tour covers the page — Add connector, the MCP endpoint, and
that every card has a tour — and `add-connector` greets the catalog the first
time it opens. Each product below is a card on `/[slug]/connectors` with a
tour of its own, pinned to that card (`requires: ['card-…']`), so a person
whose organization does not offer the product is not offered its tour
either. The card tours start only on request — from Tutorials or a
`?tour=` link — since a page of six cards would otherwise greet every visit
with the next one.

| Connector               | Notes                                            | Tour                   | Status  |
| ----------------------- | ------------------------------------------------ | ---------------------- | ------- |
| The catalog             | Add connector → search, Add                      | `add-connector`        | Covered |
| Jira                    | Atlassian OAuth; scope picker                    | `connect-jira`         | Covered |
| Jira Service Management | own Atlassian consent; Operations group          | `connect-jsm`          | Covered |
| Confluence              | Atlassian; space watches once connected          | `connect-confluence`   | Covered |
| Jira Administration     | own Atlassian app, classic scopes; for admins    | `connect-jira-admin`   | Covered |
| Jira admin changes      | review and apply proposals; from the card's link | —                      | None    |
| Bitbucket               | own OAuth system                                 | `connect-bitbucket`    | Covered |
| GitHub                  | own GitHub App; install + authorize in one click | `connect-github`       | Covered |
| Outlook                 | Microsoft; "What gets indexed" once connected    | `connect-microsoft`    | Covered |
| SharePoint              | Microsoft; library watches once connected        | `connect-microsoft`    | Partial |
| OneDrive                | Microsoft                                        | `connect-microsoft`    | Covered |
| WebEx                   | Integration OAuth; "Watch all my spaces"         | `connect-webex`        | Covered |
| Zoom                    | OAuth; ungranted-scope notice                    | `connect-zoom`         | Covered |
| OnBase                  | tenant IdP, PKCE; no scope picker                | `connect-onbase`       | Covered |
| OnBase Administration   | separate Hyland client                           | `connect-onbase-admin` | Covered |
| File shares             | per-share credentials; write/delete exposure     | `connect-fileshares`   | Covered |
| Mirth Connect           | per-instance account; permission presets         | `connect-mirth`        | Covered |
| Sandbox secrets         | on the connectors page when a sandbox is set up  | `browser-secrets`      | Covered |

SharePoint is Partial because the library watch manager (which libraries
feed knowledge search) appears only once connected and the Microsoft tour
mentions it without a step of its own.

## Organization console (operators)

One tour per area, each greeting an operator's first visit. A connector's
own page (`/admin/connectors/[configKey]`) has a tour of its own, pinned to
the registration form.

| Feature                 | Where                                  | Tour                     | Status  |
| ----------------------- | -------------------------------------- | ------------------------ | ------- |
| Console overview        | `/[slug]/admin`                        | `admin`                  | Covered |
| Connector setup         | `/[slug]/admin/connectors`             | `admin-connectors`       | Covered |
| A connector's page      | `/[slug]/admin/connectors/[configKey]` | `admin-connector-detail` | Covered |
| File shares             | `/[slug]/admin/file-shares`            | `admin-file-shares`      | Covered |
| A share's page          | `/[slug]/admin/file-shares/[shareId]`  | `admin-file-shares`      | Partial |
| Mirth Connect instances | `/[slug]/admin/mirth`                  | `admin-mirth`            | Covered |
| An instance's page      | `/[slug]/admin/mirth/[instanceId]`     | `admin-mirth`            | Partial |
| Sites                   | `/[slug]/admin/sites`                  | `admin-sites`            | Covered |
| Models                  | `/[slug]/admin/llm-models`             | `admin-models`           | Covered |
| Storage                 | `/[slug]/admin/storage`                | `admin-storage`          | Covered |
| Agent oversight         | `/[slug]/admin/agents`                 | `admin-agents`           | Covered |
| An agent's oversight    | `/[slug]/admin/agents/[agentId]`       | `admin-agents`           | Partial |
| Holiday calendars       | `/[slug]/admin/calendars`              | `admin-calendars`        | Covered |
| Organization usage      | `/[slug]/admin/usage`                  | `admin-usage`            | Covered |
| Sensitive data          | `/[slug]/admin/redaction`              | `admin-redaction`        | Covered |
| Email sanitizer         | `/[slug]/admin/email-sanitizer`        | `admin-email-sanitizer`  | Covered |
| Settings                | `/[slug]/admin/settings`               | `admin-settings`         | Covered |
| Access                  | `/[slug]/admin/access`                 | `admin-access`           | Covered |
| Audit                   | `/[slug]/admin/audit`                  | `admin-audit`            | Covered |
| Events                  | `/[slug]/admin/events`                 | `admin-events`           | Covered |
| Tutorials report        | `/[slug]/admin/tutorials`              | `admin-tutorials`        | Covered |

The Partial rows are detail pages a list tour describes without stepping
onto: a share's grants and folder limits, an instance's settings, an
agent's per-model and per-step breakdown. Each is a candidate for a tour
of its own when its page settles.
