# Knowledge layer, ACL/disclosure gates, and capability projection

The pieces that make "permission-aware" true rather than aspirational. `RENKEI.md`'s Knowledge Layer section describes the intent; this describes the code that implements it (`packages/knowledge`, `packages/gates`, `packages/capability-registry`, `packages/redaction`).

## Knowledge layer (`packages/knowledge`)

Postgres + pgvector, in the same database instance as everything else — no separate vector store.

- **Chunking** (`chunking.ts`): large objects (email, transcripts) are split at roughly 2000-char chunks with 200-char overlap, preferring paragraph → line → whitespace break points, so a chunk boundary rarely lands mid-sentence. All chunks from one object keep the same logical `refId` with a `#0001`-style suffix. Embedding calls are batched 64 at a time.
- **Units** are per connector: a mail message, a Jira issue, a Confluence page, a drive document, a Zoom transcript — and for WebEx a room's UTC day rendered as a transcript rather than a single message, which on its own is too short and context-free to retrieve (see [`connectors.md`](./connectors.md), connector-webex).
- **Chunk context** (`context.ts`): every piece of a multi-chunk object is embedded with a one-line header derived from its metadata title (`Subject: …`, `Title: …`, `Document: …`) prepended — chunks 2..n of a long page otherwise embed with no idea what page they belong to. The header goes into the embedding input only; stored content is the bare chunk. Single-chunk objects embed as they are, since every connector's document already opens with its own head (and the mail sanitizer's precomputed vector depends on that).
- **Keyword enrichment** (`keywords.ts`): at ingest, one call per object to the org's default LLM model (`llm_model_configs`, resolved through `@renkei/agent-llm`) asks for the names, identifiers and topic phrases a person would search for — up to 20, from the first 12k chars. They are stored on every chunk of the object (`keywords text[]`, migration 080) and indexed at weight B in the lexical index, between the title and the body, so a document ranks for what it is about even where its text never says so plainly. Off by default, as the org settings `knowledgeKeywordEnrichment` (Settings page → Knowledge) — one model call per indexed item is a real cost — and, when on, items shorter than `knowledgeKeywordMinChars` (default 500) are not sent at all, since a short message has nothing a model can add over its own words. Enrichment only: the setting off, no default model, a timeout or a malformed reply all mean "no keywords this time" and the object still indexes; NULL marks "not extracted" for the reindex sweep (`pnpm reindex --keywords`), an empty array "extracted, nothing worth indexing".
- **Embeddings** (`embeddings.ts`): calls an org-configured, OpenAI-compatible `/embeddings` endpoint (connector key `embeddings`) — no embedding provider ships bundled. If an org hasn't configured one, the knowledge layer is simply off for that org. The same connector row carries per-model calibration: `queryPrefix`/`passagePrefix` for asymmetric models (e5, bge, nomic, mxbai), prepended verbatim by purpose, and `maxDistance`, the cosine-distance cutoff below. `resolveKnowledge()` returns the embedder together with that tuning; `resolveEmbeddingProvider()` is the embedder alone, for ingest.
- **Storage**: table `knowledge_chunks` (`tenant_id, provider, ref_id, content, metadata, embedding, keywords, search_text, source_at`). Chunk text is encrypted at rest via `@renkei/crypto`'s content envelope. `search_text` (migration 079) is a weighted tsvector — metadata title at weight A, extracted keywords at B, chunk text at C — built from the plaintext at ingest under the `'english'` configuration and served by a GIN index. That column and `keywords` are the deliberate exceptions to content-at-rest encryption: a bag of stemmed lexemes and a short list of phrases, not the text, but they do reveal what a chunk contains and is about to anyone holding the database without the content key. Rows indexed before 079 have a NULL there until re-ingested or backfilled (`pnpm reindex --lexical` in `packages/knowledge`; `--embed` also recomputes multi-chunk vectors with the context header).
- **Retrieval** (`index.ts`, `searchKnowledge`/`listRecentKnowledge`): hybrid. One SQL statement runs two arms over the same filters — exact cosine distance over `embedding`, and `ts_rank_cd` over `search_text` for a `websearch_to_tsquery` parse of the raw query — and fuses their rank positions with reciprocal rank fusion (k = 60). Each arm overfetches `max(4k, k+16)`, capped at 60. Then, in order: the configured `maxDistance` drops semantic-only candidates beyond it (a lexical match is kept whatever its distance — exact identifiers are the case the lexical arm exists for) and counts them as `weak`; with `perDocument`, a document's chunks collapse to its best-ranked one so `k` counts documents; and every surviving candidate goes through `@renkei/gates`'s `verifyCandidates` **before** decrypting content or returning anything. Hits carry `distance`, the fused `score`, and `matched` (`semantic` / `lexical` / `both`). `relevanceOf()` grades a distance against the cutoff (strong ≤ ½, good ≤ ¾, possible ≤ cutoff) so a label means the same thing whichever model the org runs; without a cutoff the fixed 0.25/0.4/0.55 bands apply. The index itself never authorizes — it only proposes candidates.

This is the concrete implementation of `RENKEI.md`'s "the index proposes candidates, then Renkei verifies access before anything is disclosed."

## The retrieval gate (`packages/gates/acl.ts`)

Each connector that indexes content exports an `AccessVerifier`: `verifyAccess(userId, refs[]) → allowed subset` (see [`connectors.md`](./connectors.md) for which connectors implement one and how). `verifyCandidates()`:

- Races every provider's verifier concurrently against a `budgetMs` deadline.
- Denies on a missing verifier, a thrown error, or a timeout — default-deny, not default-allow.
- Returns `{allowed, elided, unverified}` so a caller can report _why_ something was withheld (denied outright vs. timed out) via `withheldNote()`, rather than silently returning fewer results.
- Honors an `ownerScoped` flag for connectors whose ACL is a pure ownership check (personal Outlook items, Zoom host-only), letting those be pre-filtered in SQL without skipping the live verification step — the verifier still runs, it's just cheap.

There is no positive-verification cache with a nonzero default TTL anywhere in this path today; `RENKEI.md` Decision #18 describes that as an org-admin policy dial that defaults to TTL 0 (verify live, every time), and the code matches that default.

## The disclosure gate (`packages/gates/disclosure.ts`)

`evaluateDisclosure(labels, channel, policy)` resolves the most-restrictive rule across a content item's classification labels for a given egress channel. Decision order, least to most restrictive: `allow < redact < anonymize < escalate < block`. An unrecognized label defaults to `block`. This is the enforcement point for `RENKEI.md`'s classification-to-handling policy — content carrying an NDA/PII/patient-data label can be blocked or redacted before it reaches an external LLM call, a drafted email, or any other egress surface, regardless of what an agent or model decided to do with it.

Neither gate is reachable from `apps/*` directly — both are consumed transitively through `@renkei/knowledge` (retrieval) and `@renkei/redaction` (egress), which `apps/web/lib/mcp-tools/knowledge/index.ts` and `apps/web/lib/mcp-tools/redaction-gate.ts` call into. That indirection is deliberate: it keeps "can this be shown" and "can this be sent" as trusted code paths below anything an LLM or agent step can influence, per `RENKEI.md`'s "both gates are enforced in deterministic code" principle.

## Redaction (`packages/redaction`)

Applied at the MCP response boundary (`apps/web/lib/mcp-tools/redaction-gate.ts`) when an org has redaction enabled (`@renkei/settings`). Works alongside, not instead of, the disclosure gate above — redaction can strip specific sensitive substrings (detector-based) from an otherwise-allowed response, while the disclosure gate makes the coarser allow/block/anonymize/escalate call on the whole item.

## Capability projection (`packages/capability-registry`)

Pure, no-I/O projection logic implementing `RENKEI.md`'s three-gate filter, AND-composed:

1. **Org policy** (`OrgCapabilityPolicy`): read-only mode, disabled connectors, disabled capabilities.
2. **Provisioned connectors** (`UserCapabilitySelection.provisionedConnectors`): a connector the user hasn't linked exposes nothing to them, regardless of org policy.
3. **User expose/hide choices** (`hiddenCapabilities`): each employee can additionally hide a capability they _do_ have provisioned.

`createProjection(org, user)` combines the three; `projectCapabilities()` filters a declared `CapabilityDescriptor[]` (id, connector, kind `'read' | 'act'`) through it. Connectors register their descriptors — no I/O, just metadata — at MCP-server build time in `apps/web/lib/mcp-tools/registry.ts`, which calls `withCapabilityGate` (`apps/web/lib/mcp-tools/capability-gate.ts`) per tool before wiring it into the server. The result: the tool list any given MCP client sees over `/api/mcp/[tenantId]/[transport]` is a genuine per-user, per-org filter computed fresh per request, never a static catalog trimmed after the fact.

See also [`connector-access-control-design.md`](./connector-access-control-design.md) for a proposed fourth gate (scoping a connector to an audience of users/groups) layered on top of this.
