# OnBase connector — design

Read against `docs/onbase-rest-api-openapi-spec.json` (OnBase Document API,
Foundation 26.1, 46 paths), `docs/Authentication & the OnBase API Server.pdf`
and `docs/OnBase Getting Started.pdf`.

No code yet. This is the shape to agree before any is written, and the four
things about OnBase that make it unlike the seven connectors already here.

---

## What makes this one different

Every existing connector talks to a vendor-hosted SaaS at a host we know at
build time — `api.atlassian.com`, `graph.microsoft.com`, `webexapis.com`,
`api.zoom.us` — through an OAuth app **we** registered once. OnBase breaks
all of that:

**1. The server is the customer's.** The spec's `servers` block is a template:
`{protocol}://{server}/{product}`, defaulting to `localhost/apiserver` and
`onbase/core`. Each tenant runs its own OnBase API Server and supplies the
URL. There is no Renkei-registered app anywhere.

**2. The identity provider is the customer's too.** Authentication goes
through a Hyland IdP instance that the customer deploys alongside the API
Server, with its own issuer, client id and scope name (`5_document_management.json`'s
_IdP Scope Name_). So the OAuth client registration is tenant configuration,
not an environment variable — the first connector where that is true.

**3. It is usually on-premises — which collides with our SSRF guard.**
`apps/web/lib/safe-fetch.ts` exists to stop a tenant-supplied URL pointing the
server at `169.254.169.254` or `localhost`, and `assertPublicHttpsUrl` rejects
every private range. An on-prem OnBase server _lives_ in a private range. The
guard as written would refuse precisely the deployments this connector is
for. **This has to be resolved deliberately, not by weakening the guard** —
see "Reaching a private host" below. It is the single biggest decision in
this document.

**4. Searching means keyword types, not text.** There is no free-text search
endpoint. `POST /documents/queries` takes a `queryKeywordCollection` of
`{typeId, value, operator, relation}` — you search by _keyword type id_. A
model holding the words "invoices from Acme over $5,000" cannot form that
query without first resolving "Vendor" and "Amount" to numeric type ids. This
is the Jira custom-field problem again, and it wants the same answer: resolve
names to ids inside the tool rather than handing the caller a lookup task
(see `apps/web/lib/mcp-tools/jira/resolve-user.ts` for the pattern and the
reasoning).

---

## Auth

**Grant type: Authorization Code with PKCE.** The Hyland documentation
recommends it for anything a user logs into, and explicitly discourages
Resource Owner Password ("deprecated in most cases… lacks security"). It also
matches how every other connector here already works, and how the run engine
already borrows a user's authority.

The IdP issues a Bearer token; the API Server validates it with the IdP on
each request. Nothing about the token is ours to interpret — same as Zoom.

**What tenant config must hold** (`connector_configs`, connector key
`onbase`):

| field                      | where it lives      | why                                   |
| -------------------------- | ------------------- | ------------------------------------- |
| API server base URL        | `settings`          | `{protocol}://{server}/{product}`     |
| IdP issuer / discovery URL | `settings`          | per-customer Hyland IdP               |
| client id                  | `settings`          | not secret                            |
| client secret              | `encrypted_secrets` | if the IdP is configured confidential |
| IdP scope name             | `settings`          | must match the API Server's config    |

`packages/connector-config` already splits exactly this way (`settings` jsonb
vs `encrypted_secrets`), so no new storage shape is needed.

**Grants** go in `provider_grants` under provider `onbase`, keyed by subject,
like every other connector. `packages/provider-grants` needs the new constant
and nothing else.

**Session lifecycle is a live question.** The auth doc points at a separate
"Session Lifecycle guide" covering session creation, heartbeat and disconnect,
which is not in the material supplied. If the API Server holds server-side
session state that expires independently of the token, a long-running agent
will hit it, and the failure will look like a random 401 rather than an
expiry. **Get that guide before implementation.**

### Reaching a private host

Three options, in the order I would argue for them:

1. **Per-tenant allow-list (recommended).** An admin registers the OnBase host
   explicitly; `safe-fetch` gains an "allowed private host" set consulted only
   for that connector's requests. The guard stays closed by default and open
   exactly where an operator has said so, which is auditable and reversible.
   Only an operator can set it — the same role that already holds connector
   credentials.
2. **Require a publicly-resolvable hostname over TLS.** Simplest, changes no
   security code, and rules out a large share of real OnBase installations.
3. **Egress proxy.** Cleanest isolation, most infrastructure.

Whichever is chosen, the DNS-rebinding caveat already noted in `safe-fetch.ts`
applies here more sharply than it does for OIDC discovery, because these
requests carry a bearer token.

---

## Tools

`onbase_*`, split Read / Act like the rest. Capability key `onbase`, config key
`onbase`, one entry in `apps/web/lib/connector-catalog.ts`.

### Read

| tool                          | endpoint(s)                                                       | notes                                                                                  |
| ----------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `onbase_search_documents`     | `POST /documents/queries` → `GET /documents/queries/{id}/results` | Two-step handle flow. Resolves keyword-type NAMES to ids for the caller.               |
| `onbase_get_document`         | `GET /documents/{id}`, `+/keywords`                               | Metadata and keyword values together — separately they are two calls for one question. |
| `onbase_read_document`        | `GET /documents/{id}/revisions/latest/renditions/default/content` | Text for the model. `latest`/`default` are documented sentinels.                       |
| `onbase_download_document`    | same, with `Accept`                                               | Bytes, for a human.                                                                    |
| `onbase_list_document_types`  | `GET /document-types`, `/document-type-groups`                    | The vocabulary a search needs.                                                         |
| `onbase_list_keyword_types`   | `GET /keyword-types`, `/keyword-type-groups`                      | Ditto — and what name→id resolution reads.                                             |
| `onbase_list_custom_queries`  | `GET /custom-queries` (+`/keyword-types`)                         | Saved queries the user already has.                                                    |
| `onbase_run_custom_query`     | `POST /documents/queries` with a `customQueryId`                  | Far more likely to be right than a hand-built keyword query.                           |
| `onbase_list_notes`           | `GET /documents/{id}/revisions/{rev}/notes`                       | See the privacy note below.                                                            |
| `onbase_get_document_history` | `GET /documents/{id}/history`                                     | Who touched it.                                                                        |

### Act

| tool                             | endpoint(s)                                          | notes                                         |
| -------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| `onbase_request_document_upload` | `POST /documents/uploads`                            | Returns the staging reference.                |
| `onbase_archive_document`        | `PUT /documents/uploads/{id}` then `POST /documents` | Completes the three-step upload.              |
| `onbase_update_keywords`         | `PUT /documents/{id}/keywords`                       | **Replaces every keyword value** — see below. |
| `onbase_add_note`                | `POST /documents/{id}/revisions/{rev}/notes`         |                                               |
| `onbase_reindex_document`        | `PUT /documents/{id}`                                | Moves a document to another type.             |

Deliberately **not** in the first cut: `DELETE /documents/{id}`, note deletion,
and the lock endpoints. Deleting a record of business origin on a model's say-so
is not a capability to ship in version one, and locks want a considered story
rather than an exposed primitive.

### Three traps worth writing down now

- **`PUT /documents/{documentId}/keywords` "sets ALL keyword values".** A
  caller that sends only the field it wants to change silently erases every
  other keyword on the document. The tool must read the current collection,
  merge, and write back — and say in its description that it does. This is the
  same class as the Jira "accepted, wrote nothing" bug: the API reports
  success either way.
- **Uploads are three calls, not one.** Stage (`POST /documents/uploads`),
  send bytes (`PUT …/{uploadId}`), archive (`POST /documents`). This maps onto
  the upload-slot pattern already in the repo (`*_request_*_upload` →
  short-lived endpoint → `check_file_upload`), and MUST: the standing rule is
  that file content never travels as a base64 tool argument.
- **`GET /notes/{noteId}/sensitive-note-text` is a separate endpoint.** Note
  text can be encrypted and is only reachable deliberately. Treat that as the
  author's intent: the note-reading tool should not fetch it, and it should
  certainly never reach the knowledge index.

---

## Knowledge indexing

Worth doing — documents are the point of OnBase — but with one problem stated
up front.

**There is no change feed, and no modified-date filter.** No delta endpoint,
no `updatedSince`. `documentDateRangeCollection` filters on the _document
date_ (a business date the user sets), not on when the record last changed. So
the freshness strategies available are:

1. a **saved custom query** the customer defines as "recently changed", run on
   the content-watch cadence — pushes the definition to the people who know
   their own OnBase configuration, and is probably the right answer;
2. a periodic full re-enumeration of a document type, which does not scale;
3. `GET /documents/{id}/history` per document, which is one call per document.

This is the same shape as Atlassian (`atlassian_content_watches` in memory:
polling only, no webhooks for OAuth apps), so the existing content-watch
machinery in `apps/worker/src/health/content-watches.ts` fits — a watch would
scope to a document type or a custom query, exactly as the Confluence watch
scopes to a space.

Content extraction reuses `packages/document-text` unchanged; the rendition
endpoint returns real file bytes with content negotiation.

---

## Where it slots in

- `packages/connector-onbase` — auth, fetch wrapper, keyword/type resolution,
  mirroring `packages/connector-webex` and `packages/connector-zoom`.
- `apps/web/lib/mcp-tools/onbase/` — the tools, with an injected `OnBaseAuth`
  (every connector now injects rather than reading `context.accessToken`
  inline — see the `connector_auth_dependency_injection` note).
- `apps/web/lib/connector-catalog.ts` — one entry, `toolPrefix: 'onbase_*'`.
- `apps/web/app/[slug]/admin/connectors` — a config card, which needs more
  fields than any existing one (base URL, issuer, scope name).
- `apps/web/app/[slug]/connectors` — a connect card; drops into the new
  column layout with no work.
- `packages/capability-registry` — capability key `onbase`.
- Migration: none. `connector_configs` and `provider_grants` already fit.

---

## Open questions before implementation

1. **Which private-host answer** (allow-list / public-only / proxy)? This gates
   everything and is a security decision, not a technical one.
2. **The Session Lifecycle guide** — is there server-side session state that
   expires separately from the token?
3. **Is there a real OnBase instance to test against?** Every trap listed above
   was found by reading; none is verified. This connector has no public
   sandbox equivalent to the Atlassian or Zoom developer tenants, so without an
   instance the first release is untested against the real thing — and given
   the keyword-overwrite behaviour, that matters.
4. **Which OnBase version(s)?** The spec is Foundation 26.1. Older servers will
   not have every endpoint here.

---

## As built (v1)

The connector shipped per this document, with the open questions resolved
so:

1. **Reaching a private host** — none of the three options above. The
   file-shares connector had meanwhile established a fourth: a dedicated
   egress worker (`apps/worker-onbase`, mirroring `apps/worker-fileshares`)
   is the only process that dials the customer's API Server or Hyland IdP —
   OIDC discovery, the PKCE code exchange, token refresh, Document API
   calls and content all cross an authenticated internal HTTP seam
   (`ONBASE_WORKER_URL` / `ONBASE_WORKER_API_KEY`,
   `apps/web/lib/onbase/service-client.ts`). The web app never resolves or
   dials the tenant-supplied hosts, so `safe-fetch` is untouched. The
   worker resolves URLs from the stored tenant config — a caller names a
   tenant, never a host — and requires HTTPS unless the operator explicitly
   saved `allowInsecureHttp`.
2. **Session lifecycle** — still undocumented; handled defensively. Any
   Document API 401 is treated as expiry however it happened: one forced
   refresh and a single retry, then the failure surfaces
   (`apps/web/lib/mcp-tools/onbase/onbase-auth.ts`).
3. **No test instance** — unchanged. The worker's suite runs against an
   in-process fake IdP + OnBase server; the tools' suites pin the traps
   (read-merge-write keywords with the keywordGuid riding the PUT, the
   3-step upload, 300-on-archive as a refusal). First deployment against a
   real Foundation server is first contact.
4. **Versions** — built to the Foundation 26.1 spec; older servers missing
   endpoints surface their own problem+json detail verbatim.

Deliberate scope cuts, per this document: no deletes, no locks, no
sensitive-note-text, and knowledge indexing deferred (retrieval-only v1 —
no content watches).

One decision this document did not anticipate: multi-environment support
(several OnBase servers per tenant) was considered and **rejected** as too
complicated — the connector is single-instance per tenant, exactly the
`connector_configs`/`provider_grants` shape described above. The only
schema change was additive: `pending_oidc_signin.code_verifier`
(migration 063) so the PKCE verifier survives the authorize redirect.
