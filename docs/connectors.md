# Connectors

Every provider integration lives in its own `packages/connector-*` package and follows the data-contract shape `RENKEI.md`'s "Connectors" section describes: what's stored in the knowledge index, what's live-query-only, and (where indexing happens) a `verifyAccess(userId, refs[]) → allowed subset` implementation that the retrieval gate calls before disclosing anything (see [`knowledge-and-security.md`](./knowledge-and-security.md)). None of the packages below talk to a database directly for their provider calls — connector packages wrap the provider API and export a verifier; the MCP tool handlers in `apps/web/lib/mcp-tools/` are the layer that actually calls them per request.

| Connector | Provider(s) | Auth model | Indexed? |
| --- | --- | --- | --- |
| `connector-atlassian` | Jira, Confluence, JSM | Per-user OAuth (Atlassian Cloud 3LO) | Live-verified via re-query |
| `connector-microsoft` | Outlook mail/calendar/tasks, SharePoint, OneDrive | Per-user delegated OAuth (Graph) | Personal items: ownership-scoped; documents: live-verified |
| `connector-fileshares` | Org-registered SMB/SFTP shares | Per-share, per-user credentials | Not indexed — no `verifyAccess`, retrieval-only |
| `connector-onbase` | Hyland OnBase (on-prem) | Auth Code + PKCE against the tenant's own IdP | Not indexed (deferred) — retrieval-only |
| `connector-sandbox` | Renkei's own agent scratch space (no external provider) | The caller's own signed-in Renkei session | Not indexed — transient staging data |
| `connector-mistral-ocr` | Mistral Document AI (OCR 4) on Microsoft Foundry | One org-wide API key per tenant (`connector_configs`) | Not indexed — a document pipeline stage, not a source of truth |
| `connector-webex` | WebEx messaging | Bot token for sending; per-user OAuth for ingestion | Live-verified (room membership) |
| `connector-zoom` | Zoom meetings/recordings/transcripts | Per-user OAuth + webhook download tokens | Ownership-scoped (host-only, v1) |

## connector-atlassian

Wraps Jira, Confluence, and JSM via a shared `atlassianFetch` gateway (`client.ts`). Auth is per-user OAuth — no service account, so a read is always scoped to what the calling user's own Atlassian token allows. The package stores nothing itself; the MCP tool surface for Jira/JSM/Confluence lives in `apps/web/lib/mcp-tools/`.

`verifier.ts` exports `createJiraAccessVerifier` and `createConfluenceAccessVerifier`. Both re-issue the candidate refs as a single batched query **using the requesting user's own token** — Jira via a `key IN (...)` JQL search, Confluence via a multi-id `GET /wiki/api/v2/pages` — so the provider's filtered response *is* the access answer; nothing is interpreted or cached locally. Default-deny on a missing credential, an API failure, or a malformed ref.

Other exports: `jiraRefId`/`confluenceRefId` (ref-id format for the knowledge index), ADF/wiki-markup converters (`adfToMarkdown`, `wikiToMarkdown`), and `fieldScreenFor`/`createScreenFor` for resolving which fields are editable on a given issue/screen.

## connector-microsoft

Wraps Microsoft Graph: Outlook mail/calendar/tasks, SharePoint document libraries, OneDrive. Auth is per-user delegated OAuth (`provider-grants`'s `MicrosoftAdapter`) — there is no org-wide credential, so ingestion can never see more than the connecting user can.

Two distinct ACL shapes, matching two distinct data shapes:

- **Personal items** (mail, calendar, tasks) are indexed only into their owner's own view. Ref id is `${upn}/${kind}/${id}`. `createMicrosoftAccessVerifier` (`verifier.ts`) does a pure ownership-string comparison — `ownerScoped: true`, no network call, because the only thing that can change is who owns the item, and that's fixed at index time.
- **Documents** (SharePoint/OneDrive drives) are shared by nature. Ref id is `${driveId}/${itemId}`. `createSharepointAccessVerifier` (`drive-verifier.ts`) checks live, per-reader, via a Graph `$batch` call — a real network round trip on every retrieval.

Sync uses Graph delta queries (`runDeltaRound`/`initialDeltaUrl`) with change-notification subscriptions (`createGraphSubscription`/`renewGraphSubscription`) that the worker renews on a sweep. Other exports: `graphRequest`/`graphBatch`, `graphUploadViaSession`, `microsoftRefId`/`sharepointRefId`.

## connector-fileshares

Wraps org-registered SMB/SFTP network shares. An admin registers only connection details (protocol/host/port/share/root path) — each employee separately connects with **their own** credentials, sealed via `credentials.ts` (`encryptCredentials`/`decryptCredentials`).

No knowledge index and no `verifyAccess`: authorization is delegated entirely to the file server itself, at operation time. This was a deliberate narrowing (migration 062) — an earlier v1 shipped an admin service-credential plus a Renkei-owned ACL engine, and that design was removed as too much security surface for what it bought. See [`fileshares-connector-design.md`](./fileshares-connector-design.md) for the history.

Exports: `openBackend` (protocol backend selection over `smb.ts`/`sftp.ts`), `service*` operations (`serviceListFolder`, `serviceReadFile`, `serviceStatEntry`, …) called by `apps/worker-fileshares`, and `store.ts`'s `createShare`/`upsertConnection`/`listConnectedShares`.

## connector-onbase

Wraps Hyland OnBase document management. Unusually, both the API server *and* the identity provider are tenant-supplied and typically on-prem — not a Renkei-registered SaaS app — so auth is Authorization Code + PKCE against whatever IdP the tenant configures.

The package itself (`packages/connector-onbase`) is deliberately dependency- and I/O-free: OIDC discovery parsing, keyword-type name resolution, the keyword-merge logic that guards the replace-everything `PUT`, query building, and a catalog cache. All actual HTTP happens in `apps/worker-onbase`, a dedicated egress process, because the tenant's private-network host can't go through `apps/web`'s SSRF guard.

Knowledge indexing is explicitly deferred — this connector is retrieval-only in v1, with no content watches and no `verifyAccess` (there is no OnBase entry in the knowledge index today). Search has no free-text mode; queries are scoped to a document type or a saved custom query, per `RENKEI.md`'s design. Sensitive note text is fetched via a separate endpoint intentionally excluded from any index.

Exports: `parseDiscoveryDocument`/`oidcDiscoveryUrl`, `resolveKeywordTypeRef`/`mergeKeywordCollections`, `buildQueryInformation`, `CatalogCache`. See [`onbase-connector-design.md`](./onbase-connector-design.md), which has an "As built (v1)" section documenting the final decisions.

## connector-sandbox

A per-caller scratch space for staging a file mid-task — the piece that lets an agent move a file from a connector that only offers a download link (`connector-fileshares`) to one that only accepts staged upload bytes (`connector-onbase`, Jira attachments) without a human relaying it by hand. Unlike every connector above, there is no external account behind this one: "auth" is simply the caller's own `(tenantId, subject)`, scoped exactly like `upload_slots`.

This is deliberately the first place Renkei holds file bytes at rest outside a provider or a browser, so it is held to a tighter bar than the rest of this table: a fixed TTL, a hard per-caller quota, no knowledge indexing, and isolation matching the credential-holding workers (`apps/worker-sandbox` is its own image, its own volume, no published ports). See [`sandbox-connector-design.md`](./sandbox-connector-design.md) for the full reasoning, including the SSRF guard on `sandbox_download_url` and how `sandbox_send_to_upload` authorizes without a bearer token.

The package itself (`packages/connector-sandbox`) is dependency- and I/O-free, the `connector-onbase` shape: filename validation, quota/TTL constants, and the egress guard — all the HTTP and disk I/O lives in `apps/worker-sandbox`.

## connector-mistral-ocr

Wraps Mistral Document AI (OCR 4) as deployed on Microsoft Foundry — a normal internet SaaS call, not an on-prem host or a per-user OAuth flow, so unlike `connector-fileshares`/`connector-onbase`/the sandbox connector it needs no dedicated isolated worker. It does its own HTTP directly (the `connector-microsoft` shape), and both `apps/web` (the ad-hoc `sandbox_ocr_file` tool) and `apps/worker` (the `document-ocr-pipeline` batch kind) call it the same way, via `resolveMistralOcrConfig`.

Auth is one org-wide API key per tenant, stored the same way every other service-credential connector here stores one: `connector_configs`' `settings` (Foundry endpoint URL, model/deployment name) plus `encrypted_secrets` (the API key) — there is no per-user grant, since Mistral OCR has no notion of "which person is asking." An org admin sets it on the Connector setup page (`apps/web/app/[slug]/admin/connectors`), the same UI every other service-credential connector here uses — `apps/web/app/api/admin/[slug]/connectors/mistral-ocr/route.ts` is its GET/PUT, following `embeddings/route.ts`'s shape (endpoint required, model optional and defaulting to `mistral-ocr-4-0`, API key required only until one is stored).

The wire contract (`packages/connector-mistral-ocr/src/client.ts`) targets Mistral's own public OCR API shape (`POST /v1/ocr`) — confirmed, not just assumed: Microsoft's own guidance says not to append `/v1/chat/completions` to the deployment's Target URI for this model, and the native `@mistralai/mistralai` SDK works against a Foundry deployment by pointing its `serverURL` at the Azure endpoint, which only works if Foundry proxies the native shape. So the configured `settings.endpoint` should be the dashboard's Target URI with `/v1/ocr` appended (e.g. `https://<resource>.services.ai.azure.com/v1/ocr`), and the request carries `extra-parameters: pass-through` — the Azure-hosted schema 422s on Mistral-native-only fields otherwise. Still worth checking the "Sample inference code" tab for the deployed model in the Foundry portal before production use, since Foundry's per-model proxying has varied; every part of the contract that might need correcting is isolated to that one file.

See [`batch-jobs-design.md`](./batch-jobs-design.md) for how this connector fits into the document-ocr-pipeline batch kind — one OCR call per source FILE (even multi-page), never a manual pre-split into page images, since OCR 4 paginates internally and Mistral bills per page either way.

## connector-webex

Wraps WebEx messaging/rooms plus its bot framework (webhooks, Adaptive Cards). Auth is dual: sending messages/cards uses a **bot token** (`WebexClient`), but knowledge **ingestion is user-scoped** — each watcher registers their own all-spaces webhook and token; there's no bot-driven reading.

For opted-in watchers, message text is indexed as `webex` chunks with ref `${roomId}/${messageId}`; metadata indexed is room id, message id, sender email, and timestamps. Everything else (room list, membership, history) is live-query only.

`verifier.ts` exports `createWebexAccessVerifier` (bot-token room-membership check) and `createWebexUserAccessVerifier` (the per-requesting-user-token variant used at retrieval time) — both verify "is this user currently a member of this message's room," asked live, once per distinct room in the candidate set.

Other exports: `verifyWebexSignature`/`parseWebhookPayload`, `ensureWebexWebhooks`/`inspectWebexWebhooks` (webhook health/repair, run on the worker's periodic sweep — see the root README's WebEx section), `buildPushToRenkeiCard`/`parsePushAction` (the "forward to Renkei" card flow, use case #3 in `RENKEI.md`).

## connector-zoom

Wraps Zoom meetings, cloud recordings, and transcripts, driven by webhooks fired on recording/transcript completion. Auth is per-user OAuth (`provider-grants`'s `ZoomAdapter`) plus the webhook's own short-lived `download_token` for fetching transcripts.

Stores meeting transcripts (VTT flattened to text via `vttToText`) and AI Companion summaries fetched on webhook events; metadata indexed is host id/email, meeting id/instance uuid, and timestamps.

`createZoomAccessVerifier` (`verifier.ts`) implements v1's host-only ACL: ref id is `${hostEmail}/${meetingUuid}`, verification is a pure string comparison (`ownerScoped: true`, no network call) since the host of a meeting is immutable once recorded. Participant-based ACL (letting invitees, not just the host, retrieve a transcript) is explicitly future work, not yet implemented.

Other exports: `ZoomClient`, `verifyZoomSignature`/`parseZoomWebhookPayload`, `zoomRefId`/`hostOfZoomRefId`.

## connector-config

Not a provider wrapper — the shared per-tenant connector configuration store every connector above reads through. `getConnectorConfig`/`setConnectorConfig` read/write the `connector_configs` table (enabled flag, non-secret `settings`, `secrets` sealed via `@renkei/crypto`'s envelope); `readConnectorConfigCached`/`invalidateConnectorConfigCache` provide a 60-second cache for hot per-event paths. This is what lets connector credentials and policy live in the database rather than environment variables (`RENKEI.md` Decision #13).

## Cross-cutting

Scoping a connector to an audience of users/groups (a fourth narrowing gate on top of the capability registry) is described in [`connector-access-control-design.md`](./connector-access-control-design.md). The batch/live `verifyAccess` contract itself, and why every candidate is checked at object level rather than a coarser container/space granularity, is Decision #18 in [`RENKEI.md`](../RENKEI.md).
