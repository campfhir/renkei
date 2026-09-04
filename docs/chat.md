# The chat

Renkei's own conversational surface: `/[slug]/chat`. A person talks to the organization's model roster with their own tool access, keeps a history, groups chats into shared **projects**, attaches files, and inserts prompts from shareable **libraries**. Everything here lives in `apps/web` (`lib/chat/`, `app/[slug]/chat/`, `app/api/tenant/[tenantId]/chat/`) plus two small packages and two worker sweeps. See [`architecture.md`](./architecture.md) for where it sits in the topology.

## Data (migrations 092, 093)

| Table                    | What                                                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chats`                  | Owned by `owner_subject` (structural, like agents); optional `project_id`; the sticky `llm_model_id`, `tool_config` (connector toolset, jsonb) and `thinking_enabled`.                                                                                     |
| `chat_turns`             | One row per Send. `status` running/completed/failed/canceled/interrupted; `updated_at` is the runner's heartbeat; `cancel_requested_at` carries Stop across replicas. Partial unique index `chat_turns_one_running` — one running turn per chat, enforced by the database. |
| `chat_messages`          | `seq`-ordered rows; `role` user/assistant; `kind` prompt/assistant/tool_results; `content` is the message's content blocks as JSON sealed under the `renc1` envelope (`@renkei/crypto`); the model that wrote a reply is snapshotted (`llm_model_id`, `provider`, `model`). |
| `chat_attachments`       | Metadata for a file in a chat or a project; bytes live in the object store under `blob_key` (`chat/{tenantId}/{attachmentId}`); `extracted_text` (sealed) is what the model reads on providers that cannot render the file.                                     |
| `chat_projects`          | A shared workspace: `instructions` (sealed), `tool_config`, `published_to_org`.                                                                                                                                                                             |
| `chat_project_memories`  | `agent_memories`' shape for a project: entries plus one summary, sealed, with `author_subject` and the originating `chat_id`.                                                                                                                              |
| `resource_access_grants` | Named-person sharing for `chat` (viewer only), `chat_project` and `prompt_library` (viewer/editor), optional expiry. Polymorphic (`resource_kind`, `resource_id`, no FK) — resources delete their grants in code; the worker prunes orphans.                    |
| `prompt_libraries`, `prompts` | Libraries with `published_to_org`; prompt bodies are plaintext templates.                                                                                                                                                                             |

Retention is the org setting `chatRetentionDays` (default 0 = keep), enforced by `apps/worker-agents/src/chat-sweep.ts` — attachment blobs are deleted before rows, and a chat whose blob could not be deleted waits for the next sweep. Token spend is recorded in `llm_calls` with `purpose = 'chat'`.

## Access (`lib/chat/access.ts`)

One resolver family, the `agent_access_grants` rules generalized:

- Owner → `owner`. A named grantee → the grant's role while unexpired. A published project or library → `viewer` for anyone in the tenant.
- A chat is readable by its owner, a named viewer, or any member of the project it sits in (`resolveChatAccess`); only the owner may continue it. Nobody else resolves — null, surfaced as 404, never 403.
- Moving a chat between projects (`POST …/chats/[chatId]/move`) changes only `project_id`; the next turn picks up the new project's instructions, memory and toolset, and its members gain read access from then on.

## A turn (`lib/chat/start-turn.ts`, `turn-runner.ts`)

`POST …/chats/[chatId]/turns` does only what must precede the response: resolve the model (`resolveAgentLlm` — the request's model, else the chat's sticky one, else the org default), redact the typed text (below), and in one transaction insert the turn row, the prompt row and an empty `streaming` assistant row. It answers **202** with the ids and hands the rest to Next's `after()`.

`executeChatTurn` then resolves the tool surface, builds the prompt and history, and runs the loop:

1. `streamOrComplete(provider, …)` streams the reply. Every `LlmStreamEvent` is mirrored into the assistant row's blocks (flushed to the database on a timer that doubles as the heartbeat) and onto the turn's in-process channel (`turn-events.ts`).
2. If the reply ended in tool calls, each is run in order — the chat's local tools (`chat_read_attachment`, `chat_attach_to_sandbox`, `project_memory_*`) in-process, everything else through the person's own MCP surface — and the results are stored as a user-role `tool_results` row; a fresh assistant row is opened and the loop continues.
3. Otherwise the turn completes. Limits: 10 minutes wall clock, 25 iterations, 60k chars per tool result, two rendered attachments per turn.

Cancel: `POST …/cancel` marks `cancel_requested_at` and aborts the in-flight request when the turn runs in this process; other replicas see the flag on their next heartbeat. A runner that dies leaves rows the janitor (`createChatTurnJanitor`, every 5 min) marks `interrupted` once the heartbeat is 15 minutes stale.

### Tools (`lib/chat/tool-surface.ts`)

The chat calls the app's **own MCP endpoint** with a token minted for the turn (`@renkei/mcp-client`, application `agent`, `agent_id` null, the person's roles attached), exactly as the agents worker does — so capability projection, read-only mode, usage tracking and redaction all apply unchanged. What is offered is the intersection of the in-process catalog (`listAvailableTools`, authoritative for connector and app-only) and the endpoint's `tools/list` (authoritative for schemas), narrowed to the chat's toolset: `tool_config.connectors` on the chat, else the project's, else the core set (`knowledge`, `sandbox`); `whoami` always; `*_preview` tools never (they render cards the chat cannot show). No token is minted when the toolset yields nothing.

### The request (`lib/chat/request-builder.ts`)

The system prompt carries a standing brief, the person, the project's instructions and rendered memory, and the files at hand. History is the chat's rows repaired for the provider: thinking blocks are replayed only within the turn that produced them and only to the same Anthropic model (a switch mid-chat strips them — every turn resends the whole conversation anyway); a `tool_use` without its `tool_result` in the next row is dropped; empty blocks and failed rows are skipped. Anthropic requests mark the system prompt and tool list for prompt caching and, when the chat has thinking on, ask for a budget of 60% of the org's output cap.

### Redaction (`lib/chat/outbound-redaction.ts`)

Tool results are redacted at the MCP boundary as always. What that gate never sees — the typed message, extracted attachment text, project instructions and memory — goes through the same detectors, policy and pseudonymizer on its way out, and the **redacted form is what is stored**, so the transcript equals what the model saw.

## Streaming to the browser (`…/turns/[turnId]/stream`, `lib/chat/stream-events.ts`)

One `text/event-stream` per open turn, `runtime = 'nodejs'`. When the turn runs in this process the route subscribes to its channel and forwards events with sequence ids, replaying from the browser's `Last-Event-ID` after a reconnect (ring of 2,000). Otherwise — another replica, a restart, a ring gap — it sends the turn's rows as a `snapshot` and re-reads them every second, emitting only on change until the turn settles. The client reducer (`applyStreamEvent`) is shared with the server and treats a snapshot as "replace this turn's messages", so both paths converge on the same thread.

## Attachments (`lib/chat/attachments.ts`, `@renkei/blob-store`)

Uploads are raw bytes `PUT` to `…/chat/attachments?chatId=|projectId=`, capped by the org's `maxAttachmentBytes` before and after reading. Bytes go to the object store (`packages/blob-store`: an interface with an Azure Blob backend, chosen by `BLOB_STORE_PROVIDER`; unconfigured means uploads are off); text is extracted with `@renkei/document-text` (or decoded for text types), redacted and sealed. A prompt inlines an excerpt of each attached file's text (40k chars) and, for PDFs and images on Anthropic, a document/image block; the model pages through the rest with `chat_read_attachment` and stages bytes into the sandbox with `chat_attach_to_sandbox`. Downloads always stream through the app under a session check, as attachments with `nosniff`, never via signed URLs.

## UI (`app/[slug]/chat/`)

A two-column shell (`data-wide-page`): the sidebar (my chats by day, shared with me, projects, prompt libraries) beside the thread, a drawer below `lg`. The thread renders blocks in order — text as Markdown (`react-markdown` + `remark-gfm` + `rehype-highlight`, raw HTML skipped, links open elsewhere without a referrer), thinking and tool calls as folded `<details>` with each call's result inside it, a cursor while streaming. The composer sends on Enter (touch keyboards use the button), uploads dropped or pasted files at once, switches model and thinking, narrows the toolset, and inserts prompts (`/` on an empty box). Viewers of a shared chat see a banner and no composer, but the stream still runs.

## Environment

- `RENKEI_WEB_INTERNAL_URL` — where the web app reaches its own MCP endpoint (defaults to loopback on `PORT`).
- `BLOB_STORE_PROVIDER=azure` plus `AZURE_BLOB_ACCOUNT`, `AZURE_BLOB_KEY`, `AZURE_BLOB_CONTAINER`, optional `AZURE_BLOB_ENDPOINT` — see `DEPLOYMENT.md`; the dev compose file runs Azurite.
