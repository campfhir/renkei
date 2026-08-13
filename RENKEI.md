# Renkei

**Renkei** (連携 — "linkage, cooperation") is a collaboration platform for employees that connects the tools an organization already lives in — WebEx, Outlook, SharePoint, Confluence, Zoom, Jira — into a single, permission-aware knowledge and action layer. It is both an **agentic system** (it can watch, correlate, and act on information autonomously) and a **human-in-the-loop workspace** (it curates what it finds into reviewable cards and suggestions rather than acting blindly).

The core bet: the most valuable information in an organization is scattered across chat messages, meeting transcripts, email threads, wiki pages, and documents — and no one tool sees all of it. Renkei sees all of it, on the employee's behalf, with the employee's permissions, and turns it into answers and actions.

> **Amended 2026-08-07** after a full review of this codebase against the plan. The changes: Decision #5 restated (tenant = org), a process-topology decision added (#17), the ACL-verification latency question resolved into a design (#18), a hygiene gate added ahead of the Phase 0 restructure, and the "Jira MCP server moves in" phrasing corrected to match what the code actually is. (The review also flagged a drift between the deployed MCP server and this repo; it was resolved when the seven missing tool modules landed on main.)

---

## What Renkei is (and isn't)

**Renkei is:**

- A **hub**, not another silo. Data flows in from the tools people already use; actions flow back out to those same tools.
- **Bidirectional.** Other tools push into Renkei (webhooks, bots, forwarding), and Renkei reaches into other tools (APIs, live queries). Employees can meet Renkei wherever they are — inside WebEx, inside their LLM chat, or in the Renkei web interface.
- **An MCP provider.** Any LLM the employee works with can tap Renkei's knowledge and actions through a bespoke, tailored MCP interface. The existing Jira work-items MCP server is the first instance of this pattern.
- **Agentic with a human in the loop.** Renkei can queue up autonomous actionable items behind the scenes, but the default posture is _suggest, then act on approval_ — curated cards, daily briefings, one-click confirmations.

**Renkei is not:**

- A replacement for WebEx, Outlook, or Confluence. People keep their tools; Renkei is the connective tissue.
- **A system of record or a data warehouse.** The providers remain the source of truth. Renkei stores only what a connector deliberately decides to store — some connectors index content, some index only metadata, and some are pure retrieval tools that store nothing at all.
- A fully autonomous agent that fires off emails and tickets without oversight (though specific workflows can be promoted to autonomous once trusted).
- A generic search appliance. Retrieval is in service of _action_ — the question is always "what should happen next with this information?"

---

## Use cases

These are the scenarios that define the product. Everything in the architecture exists to serve one of these.

### 1. Issue triage from chat

A staff member sends a WebEx message reporting an issue. Behind the scenes, Renkei:

1. Ingests the message (via the WebEx bot / webhook).
2. Analyzes it and enriches it — checks it against Confluence runbooks and SharePoint documents for known issues, prior incidents, or relevant policy.
3. Queues an **actionable item**: when the employee logs into Renkei, they see a curated card — "This looks like a recurrence of the login-timeout issue documented in Confluence page X. Suggested actions: create a Jira ticket (pre-drafted), notify the on-call channel, reply with the workaround."
4. The employee approves, edits, or dismisses. Approved actions execute: the Jira ticket is created, the email is composed.

### 2. Cross-tool recall in an LLM conversation

An employee is chatting with an LLM and says: _"Pull up the email exchange I had with Sam about the vendor contract, and the SharePoint document it references."_ The LLM, connected to Renkei over MCP, queries Renkei's knowledge layer, retrieves the thread and the document (respecting the employee's actual access rights), and grounds the rest of the conversation in them. The outcome might be: draft a follow-up email, create a Jira ticket, schedule a meeting — all through Renkei's action tools.

### 3. Forward-to-Renkei from inside the tool

An employee sees a message in WebEx: _"Hey, can I get the Q4 rev cycle reports?"_ Rather than context-switching, they click a button or forward the message to Renkei right within the WebEx client. Renkei processes the request — finds the Q4 data in SharePoint, assembles it — and responds in-thread or via a card: _"Here is the Q4 data."_ The employee (or eventually Renkei itself) sends it along.

### 4. The daily briefing

An employee logs into Renkei and sees: **"Here are 5 things you should know today"** —

- Schedule a meeting with stakeholders to discuss the product launch (three email threads and a Zoom transcript suggest this is overdue).
- You have a pending PTO request to approve.
- A new Confluence document was published covering the product launch.
- The Jira epic you own has two blocked tickets with no movement in a week.
- Sam's message from yesterday still needs a reply.

Each item is a card with context and one-click actions. This is Renkei acting as a chief of staff: watching everything, surfacing only what matters.

---

## Architecture

Five layers. Data flows down into the knowledge layer and back up out of the action layer.

```
┌─────────────────────────────────────────────────────────────┐
│  SURFACES — where employees meet Renkei                     │
│  Renkei web app · MCP interface (any LLM) · in-tool         │
│  extensions (WebEx bot/buttons, Outlook add-in, browser)    │
├─────────────────────────────────────────────────────────────┤
│  ORCHESTRATION — the agentic core                           │
│  event processing · enrichment/correlation · task queue ·   │
│  curated cards · autonomous workflows · approval gates      │
├─────────────────────────────────────────────────────────────┤
│  KNOWLEDGE — what Renkei knows                              │
│  vector store + metadata store · permission-aware           │
│  retrieval · entity graph (people, projects, documents)     │
├─────────────────────────────────────────────────────────────┤
│  CONNECTORS — how data gets in and out                      │
│  webhooks (push) · pollers/delta sync · live query          │
│  (pass-through) · per-provider adapters                     │
├─────────────────────────────────────────────────────────────┤
│  PROVIDERS                                                  │
│  WebEx · Zoom · Outlook/Calendar · SharePoint ·             │
│  Confluence · Jira                                          │
└─────────────────────────────────────────────────────────────┘
```

### Connectors (ingestion & egress)

Each provider gets an adapter with up to three modes, chosen per data type:

| Mode                          | When it fits                                                          | Examples                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Webhook / push**            | Real-time events the provider will send us                            | WebEx messages to the bot, Zoom "transcript ready," Confluence page published, Microsoft Graph change notifications for mail/calendar |
| **Poll / delta sync**         | Bulk or historical data; providers with weak webhooks                 | SharePoint document libraries via Graph delta queries, Confluence space backfill, mailbox history                                     |
| **Live query (pass-through)** | Fresh, targeted lookups where syncing everything is wasteful or risky | "Search Sam's calendar for free slots," Jira JQL queries, pulling one specific SharePoint file on demand                              |

The honest architectural stance: **Renkei is not storage, and not everything should be synced into the vector DB.** Chat and transcripts are high-value, low-volume — sync them. Email is sensitive and enormous — its indexing scope is **user-defined, within org defaults and org limits**: each employee chooses what of their mail gets indexed, the org sets the starting policy and the hard ceiling. SharePoint can be both — index the documents the org marks as knowledge, live-query the rest.

Ingestion mechanics stay clean through a single rule: **everything is an event.** Where a provider supports push (Microsoft Graph change notifications, WebEx webhooks, Zoom transcript-ready), events arrive natively. Where it doesn't — or where a subscription lapses — a **scheduler acts as the producer**, running sync jobs that emit the very same events into the pipeline. Downstream, the orchestration layer never knows or cares whether an event came from a webhook or a scheduled sweep. Concretely (see Decision #17): webhook routes and scheduler jobs both do exactly one thing — insert a row into the same `events` table — and the worker consumes that table; "the scheduler is just another producer" is a statement about a shared INSERT, not an abstraction.

To make that enforceable rather than aspirational, **every connector ships a data contract** that explicitly declares:

1. **What content is stored** in the knowledge layer (if any).
2. **What metadata is indexed** (source, author, timestamps, thread/space identifiers, ACL references).
3. **What stays retrieval-only** — answered by live pass-through to the provider, never persisted.
4. **What is shared to which user, in detail** — the per-user visibility rules for everything the connector exposes. No connector ships without this section; a connector that can't articulate its sharing rules doesn't get deployed.
5. **A `verifyAccess` implementation** — the live access-verification hook the retrieval gate calls (see the knowledge layer below and Decision #18). A connector that indexes content but cannot verify a user's current access to it doesn't get deployed either.

Connectors are also **composable**: one connector's enrichment can leverage another's. Jira triage can pull the WebEx thread that prompted the ticket; a WebEx card can cite the Jira epic and the Confluence page it correlates with. The orchestration layer treats connectors as capabilities that can be interwoven, not isolated pipes.

Provider realities to plan around:

- **Microsoft Graph** (Outlook, Calendar, SharePoint) uses change-notification subscriptions that expire and must be renewed; delta queries are the reliable sync backbone.
- **WebEx** has a proper bot framework with webhooks, Adaptive Cards, and message-level buttons — this is what makes use case #3 possible natively.
- **Zoom** fires webhooks when cloud recordings/transcripts complete; transcripts arrive as VTT to fetch and chunk.
- **Atlassian** (Confluence, Jira) supports webhooks and rich REST APIs; Jira is already covered by this repo's MCP server.

### Knowledge layer

- **Vector store: Postgres + pgvector**, living inside the single database instance. Semantic retrieval over chunked content (transcripts, messages, pages, documents, selected email) with vectors joined directly to relational metadata — so candidate narrowing and metadata joins happen in SQL, in one query, not across two systems. Authorization, however, is _not_ done in SQL — see below.
- **Metadata store** alongside it (same database): source, author, timestamps, thread/space/site identifiers, and — critically — **a durable reference back to the source object**, so access can be re-verified against the provider at query time. Any permission hints stored in the index are candidate-narrowing optimizations only, never authorization.
- **Permission-aware retrieval** is the non-negotiable hard problem. When an employee (or an LLM acting for them) queries Renkei, results MUST be trimmed to what _that person_ can see in the source system. The decided approach: **the primary interaction model is per-user, and Renkei piggybacks on each provider's own ACLs** — per-user auth against WebEx, Zoom, Microsoft, and Atlassian so the provider itself enforces access, exactly as the Jira MCP server does today. Renkei does not invent its own permission model; each connector's data contract spells out how provider permissions map onto anything it stores.

  Critically, **ACLs are checked live at query time, never baked into the index at indexing time.** Retrieval is two steps: the index proposes candidates, then Renkei verifies the requesting user's access to each candidate against the provider _before anything is disclosed_. If someone lost access to a document after it was indexed, the live check catches it at the gate (and flags the stale entry for cleanup). Provider unreachable or verification ambiguous → default deny. Getting this wrong turns Renkei into a data-leak amplifier; the design defaults to over-restriction.

  The verification mechanics are decided (Decision #18): every connector implements `verifyAccess(user, refs[]) → allowed subset`, the gate calls it with the candidate set, and **every candidate is checked at object level** in v1. The interface is batch-shaped so connectors are free to use provider batch endpoints internally (Jira `POST /rest/api/3/permissions/check`, Graph `$batch`), but no granularity shortcuts (container- or space-level collapsing) exist in the contract yet — those are a later optimization that must not change the guarantee. A per-`(user, ref)` positive-verification cache exists as an **org-admin policy dial that defaults to TTL 0** — out of the box, every query verifies live, and any relaxation is an explicit, logged governance choice. Per-query verification has a hard time budget; candidates unverified when it expires are dropped and the response says results were elided.

- **Disclosure controls & data classification** are core, not bolt-on. Content carries classification labels — _NDA-covered: do not send to third parties_, _patient information: must be anonymized or redacted_, _PII_, _confidential_ — sourced from provider metadata, org policy rules, and classifiers in the ingestion pipeline. Every egress path passes through a **disclosure gate** that enforces the label's handling rules: block, redact, anonymize, or require explicit human approval. "Egress" is defined honestly: sending content to an external model API over MCP _is_ third-party disclosure, so NDA-covered or patient data may be barred from the very LLM calls the pipeline would otherwise make. Org-admins author the classification-to-handling policy; the gate applies it uniformly across every surface.
- **Both gates are enforced in deterministic code — never inferred by an LLM or agent.** ACL verification and disclosure enforcement are trusted code paths that sit _below_ the agentic layer: no prompt, model output, agent decision, or tool argument can waive, reinterpret, or route around them. The one nuance: classifiers may _suggest_ classification labels at ingestion, but once a label is attached, its handling rules execute deterministically — and where classification is uncertain, content gets the most restrictive plausible label until a human resolves it. Models reason over what the gates release; they never decide what the gates release.
- **Entity graph** (people, projects, documents, tickets, meetings) that lets Renkei correlate — "this WebEx message, that Confluence page, and this Jira epic are all about the product launch."

### Orchestration (the agentic core)

- **Event pipeline:** every inbound event (message, transcript, document publish, email) flows through classification → enrichment (retrieve related knowledge) → decision (is this actionable? for whom?).
- **Task queue of actionable items:** the output of the pipeline. Each item carries its evidence (source links), its analysis, and its suggested actions.
- **Curated cards:** the human-facing rendering of actionable items — in the Renkei app, in the daily briefing, or pushed back into WebEx as an Adaptive Card.
- **Approval gates and autonomy levels:** every workflow has a dial — _suggest only_ → _act with one-click approval_ → _act autonomously and report_. Workflows earn autonomy per-user, per-type, over time.
- **Audit trail:** everything Renkei ingested, inferred, suggested, and did is logged and inspectable. Trust depends on this.

### Surfaces

1. **Renkei web app** — the home base: daily briefing, actionable-item cards, search across everything, workflow configuration, audit history.
2. **MCP / A2A interface** — the model- and agent-facing surface. **Models live outside Renkei**; Renkei hosts no LLMs of its own for this surface. Instead it exposes MCP tools (`search_knowledge`, `get_thread`, `find_document`, `create_jira_ticket`, `draft_email`, `schedule_meeting`, `list_actionable_items`) for models, and an agent-to-agent surface implementing the [A2A protocol](https://github.com/a2aproject/A2A) — Renkei publishes an Agent Card advertising its capabilities, and external agents delegate tasks to (and receive tasks from) Renkei's orchestration layer over A2A. The Jira work-items MCP server is the seed; the pattern generalizes into a Renkei MCP gateway.

   Neither surface hardcodes its capabilities. Connectors and knowledge modules **register their capabilities through a platform registry when they are added** — the same way tools get registered on an MCP server. What any given user (or an agent acting for them) actually sees is the registry filtered through three gates, in order: the **org-admin's capability flags** (is this capability enabled for the org at all, and within what limits?), the user's **provisioned connectors** (an employee links their own WebEx/Microsoft/Atlassian accounts; unprovisioned connectors expose nothing), and the user's **own expose/hide choices** (each employee decides which of their provisioned capabilities are surfaced to models and agents). The Agent Card and MCP tool list are per-user projections of that filtered registry, never a global catalog.

3. **In-tool extensions** — the WebEx bot (buttons, cards, forward-to-Renkei), an Outlook add-in ("send this thread to Renkei"), and eventually equivalents for other tools. These make Renkei ambient rather than yet-another-tab.

### Action layer

Actions are first-class, typed, and reversible where possible: create/update Jira issues, compose/send email (compose-as-draft by default), schedule meetings, post replies to WebEx, publish or comment on Confluence. Every action records what triggered it and who approved it — and every action's outbound content passes through the disclosure gate before it leaves (an email draft quoting an NDA-covered document to an external recipient gets blocked or flagged, not sent).

---

## Cross-cutting concerns

- **Topology — modular monorepo with an explicit process split:** Renkei is built as a monorepo, but every connector, the knowledge layer, the orchestration pipeline, and each surface is a well-bounded module with an explicit interface. The skeleton (Decision #17) is three-part:
  - **`apps/web`** — the Next.js app: all surfaces, the MCP gateway, the OAuth/OIDC machinery, the admin UI, and **webhook receipt only** — a webhook route verifies the signature, inserts the raw event row, and returns 200; it never processes.
  - **`apps/worker`** — a long-running Node process: the event pipeline (classify → enrich → decide), the schedulers-as-producers, and provider subscription renewal. Anything that must _keep running_ lives here, never in a request handler.
  - **`packages/*`** — the shared modules extracted from today's `lib/`: database (Kysely + migrations), crypto, the provider-grant lifecycle, and one package per connector. MCP tool handlers stay web-side; the underlying provider clients live in the connector packages so both processes use the same code.

  The queue between them is a Postgres `events` table consumed with `FOR UPDATE SKIP LOCKED` (attempts column for retries, dead-lettering) — no new infrastructure, one database (Decision #11 intact). Nothing prevents extracting a module into a microservice later; the module boundaries are drawn as if that extraction will eventually happen. Monorepo for velocity now, service-shaped seams for scale later.

- **Identity:** Renkei must map one human across five identity systems (WebEx email, Microsoft UPN, Atlassian account ID…). An internal identity spine — likely keyed off the org's SSO/Entra ID — with per-provider linked accounts. The existing per-org OIDC configuration (`tenant_oidc`) is the seed of this spine: the OIDC `subject` is already the key that binds sessions, MCP tokens, and provider grants together.
- **Governance — org-admins:** a distinct role that owns the platform's policy surface. Org-admins set the org defaults and limits (email indexing ceilings, retention), **connector limits**, and **connector capability flags** — which capabilities are enabled org-wide and under what constraints. Employees operate inside that envelope: they provision their own connectors and choose what to expose or hide, but never beyond what the org-admin has enabled. Org-level policy lives on the org's row and its satellite tables (see Decision #5): the existing `tenants` entity _is_ the org.
- **Auth:** per-user OAuth wherever the provider supports it (so actions happen _as the user_ and reads honor _the user's_ permissions), falling back to service/bot accounts only for org-level ingestion. Token vaulting, refresh, and revocation are platform-level services, not per-connector afterthoughts. The existing grant machinery (subject-bound `provider_grants`, encrypted at rest, cross-process refresh locking) is that service's v1; extracting its Atlassian-specific code behind a provider interface is Phase 0 work, done while Atlassian is still the only implementation.
- **Security & compliance:** this system aggregates the most sensitive data in the company. Encryption at rest, retention policies per source type (transcripts may have different legal retention than email), and the ability to purge a source's data cleanly. Renkei runs with a **single-org deployment posture** — one org, one deployment, one database instance — which keeps the security story simple. The schema, however, stays org-aware (the existing tenant model; see Decision #5): every table carries the org FK, and serving a second org from one deployment is deliberately not foreclosed, just not a goal.
- **Observability:** connectors will silently rot (expired subscriptions, revoked tokens, API deprecations). Health dashboards and alerting on ingestion staleness are a feature, not ops garnish. The worker is the natural home for this — it is the process that knows when ingestion went quiet.
- **LLM strategy:** models live **outside** Renkei — the platform hosts no models. The orchestration layer's classify/enrich/decide steps call external model APIs, and employee-facing models and agents connect inward through the MCP/A2A surface. Costs and latency still scale with event volume, so the pipeline should tier models — cheap/fast classification on every event, heavier reasoning only for items that survive triage.

---

## Roadmap

Phasing follows a rule: **each phase ships a complete loop** (ingest → know → suggest → act) for a narrow slice, rather than building all connectors first and features later.

### Phase 0 — Foundation (where we are)

**Hygiene gate — before any restructuring:**

- CI from zero (there is currently no `.github/` and no `lint` script): lint + typecheck + jest on every PR.
- Delete dead modules: `lib/config.ts`, `lib/crypto.ts`, the unwired `lib/crypto/envelope.ts` (git preserves it for a future BYOK need), the orphaned `lib/atlassian-api.test.ts`, and the unused `@modelcontextprotocol/sdk` dependency.
- Delete or rewrite stale docs: `API.md` documents an endpoint that doesn't exist; `COMPLETED.md` and `MIGRATION.md` describe a superseded architecture; `README.md` is untouched boilerplate.
- Fix three known bugs, each with a regression test: the MCP handler cache captures the access token by value (every call after first expiry pays a 401 + refresh + retry); `connect_jira` queries grants tenant-wide (revealing other users' connection state) and builds an authorize URL whose `state` can never validate; `attachments.ts` bypasses the refresh-aware fetch and enforces no size limit.

**Then the foundation proper:**

- Restructure into the monorepo topology of Decision #17 (`apps/web`, `apps/worker`, `packages/*`). An honest note on scope: the Jira MCP server is not a module that "moves in" — today it _is_ the app, with auth, OAuth serving, and discovery woven through it. Phase 0 is the work of teasing it apart along the web/worker/packages seams, and of extracting the provider abstraction (grant lifecycle, token refresh) behind an interface **while Atlassian is the only implementation** — adding Microsoft later must mean new rows and a new connector package, not new bespoke routes.
- Stand up pgvector in the single Postgres instance and the `events` table + worker consumer (webhook and scheduler producers emitting one event model).
- Design the capability registry interface — how connectors declare and register what they offer.
- Build the two enforcement gates as pipeline primitives: **live ACL verification** on retrieval (the `verifyAccess` contract of Decision #18) and the **disclosure gate** on egress — both as deterministic, trusted code paths below the agentic layer. Every later phase builds on top of these; they cannot be retrofitted.
- Decisions to lock: identity spine details, token vault, initial classification taxonomy.

### Phase 1 — First loop: WebEx → knowledge → Jira

- WebEx bot with webhook ingestion of messages.
- Minimal knowledge layer (vector store + metadata + basic permission model).
- Event pipeline v1: classify a message, retrieve related context, produce an actionable item.
- Minimal Renkei web app: a feed of curated cards with approve/dismiss.
- Action: create a Jira ticket from a card (via the existing MCP/Jira layer).
- _This delivers use case #1 end to end._

### Phase 2 — Knowledge depth: Confluence + SharePoint

- Confluence connector (webhooks + space backfill) and SharePoint connector (Graph delta sync for designated libraries).
- Enrichment now checks reported issues against real org knowledge.
- Renkei MCP gateway v1: `search_knowledge` and retrieval tools exposed to LLMs.
- _This delivers use case #2's retrieval half and makes #1 genuinely smart._

### Phase 3 — Communication: Outlook mail & calendar

- Graph change notifications for mail/calendar where supported, with the scheduler-as-producer sweeping as fallback — both emitting the same events.
- Email indexing policy engine: user-defined scope within org defaults and org limits.
- Actions: draft email, schedule meeting.
- Entity graph v1 — correlating threads, people, meetings, documents.
- _Completes use case #2 (email recall → SharePoint doc → composed outcome)._

### Phase 4 — Ambient Renkei: in-tool extensions & the briefing

- WebEx forward-to-Renkei buttons and Adaptive Card responses (use case #3).
- Daily briefing: the "5 things you should know today" synthesis over the whole knowledge layer (use case #4).
- Outlook add-in.

### Phase 5 — Earned autonomy: Zoom + workflow maturity

- Zoom transcript ingestion (meetings become knowledge; action items extracted automatically).
- Autonomy dials: workflows promotable from _suggest_ to _autonomous_ per user.
- Workflow builder: let teams define their own trigger → enrich → action patterns.

---

## Decisions

1. **Renkei is not storage.** Providers stay the source of truth. Each connector's data contract decides what gets stored, what metadata gets indexed, and what remains a pure retrieval tool.
2. **Permissions are per-user and delegated to the provider.** The main interaction model is per-user. Renkei piggybacks on WebEx/Zoom/Microsoft/Atlassian ACLs via per-user auth — the same pattern the Jira MCP server uses today — and every connector explicitly defines in detail what data is shared to a user.
3. **Connectors are composable.** Jira can leverage WebEx, WebEx can leverage Jira; the orchestration layer interweaves connector capabilities rather than treating them as isolated pipes.
4. **Modular monorepo.** One repo, hard module boundaries, so any module can be extracted to a microservice later without a rewrite. (Process topology in #17.)
5. **Single-org deployment posture; the schema stays org-aware.** _(Restated 2026-08-07; previously "single-tenant, single database.")_ One org, one deployment, one database instance — but the existing tenant model is kept, because the code's "tenant" **is** the org: it is where org-admin defaults, limits, and capability flags (#13) live, and per-org OIDC is the identity spine's seed. Consequences: every platform table carries the org FK (including `platform_audit_log`, which is missing it today and must be fixed); new tables never omit it; the unwired per-tenant BYOK module (`lib/crypto/envelope.ts`) is deleted rather than left as a second crypto path. Multi-org _service_ is still a non-goal — this is a posture, not a product direction.
6. **Email indexing is user-defined within org policy.** Each employee chooses their indexing scope; the org supplies defaults and enforces limits.
7. **Everything is an event; the scheduler is just another producer.** Event-driven ingestion where providers push; scheduled sync jobs emit the identical events where they don't. Both are INSERTs into the same `events` table; the pipeline model stays clean either way.
8. **Models live outside Renkei.** The platform hosts no LLMs. External models and agents connect through MCP and A2A interfaces; the internal pipeline calls external model APIs.
9. **The Jira MCP server is the first connector module** — by restructuring, not relocation: today it is the whole app, and Phase 0 teases it apart along the `apps/web` / `apps/worker` / `packages/*` seams, extracting the provider abstraction while Atlassian is the only implementation.
10. **The agent surface uses the [A2A protocol](https://github.com/a2aproject/A2A)** (Agent2Agent, Linux Foundation). Renkei publishes an Agent Card and speaks A2A for task delegation to and from external agents; MCP remains the tool-facing complement.
11. **Postgres + pgvector** is the store — vectors and relational metadata in the single database instance, so candidate retrieval and metadata filtering are one SQL query, not a cross-system reconciliation. (Authorization is not SQL — see #14.)
12. **Capabilities are registered, not hardcoded.** Connectors and knowledge modules register their capabilities through a platform registry when added (the MCP tool-registration pattern, generalized). Employees provision their own connectors and choose what to expose or hide; the MCP tool list and A2A Agent Card are per-user projections of the filtered registry.
13. **Org-admins govern the envelope.** A dedicated role sets org defaults and limits, connector limits, and connector capability flags. Employee choices operate strictly within what org-admins have enabled.
14. **ACL checks are live, at query time — never baked into the index.** The index proposes candidates; access is verified against the provider with the requesting user's credentials before anything is disclosed. Revoked access is caught at the gate even if the content was indexed earlier. Provider unreachable → default deny. (Mechanics in #18.)
15. **Disclosure controls are core.** Content carries classification labels (NDA-covered, patient information, PII, …) and every egress path — MCP/A2A responses, external model API calls, composed emails, posted cards — passes a disclosure gate that blocks, redacts, anonymizes, or escalates per org-admin-authored policy.
16. **Gates are deterministic code, never LLM-inferred.** ACL verification and disclosure enforcement are trusted code paths below the agentic layer — no prompt, model output, or agent decision can waive or route around them. Classifiers may suggest labels; label enforcement is deterministic, and uncertain classification defaults to the most restrictive label.
17. **Web + worker + packages, queued through Postgres.** _(Added 2026-08-07.)_ `apps/web` (Next.js: surfaces, MCP gateway, OAuth/OIDC, admin, thin webhook receipt) and `apps/worker` (event pipeline, schedulers, subscription renewal) share `packages/*` extracted from `lib/`. The queue is a Postgres `events` table consumed with `FOR UPDATE SKIP LOCKED` — no new infrastructure; pgmq only if queue semantics ever demand it. Long-running or stateful work never lives in a request handler.
18. **ACL verification is batch-shaped, per-object, and strict by default.** _(Added 2026-08-07; resolves the former latency open question.)_ Every connector's data contract includes `verifyAccess(user, refs[]) → allowed subset`; v1 checks **every candidate at object level** — no granularity shortcuts in the contract (provider batch endpoints are an internal implementation freedom; container-level collapsing is a later optimization that must not change the guarantee). The positive-verification cache is an org-admin policy dial **defaulting to TTL 0**: out of the box every query verifies live, and relaxation is an explicit governance act. Per-query verification has a time budget; unverified candidates are dropped and the elision is reported.
19. **Minimal environment; configuration is data.** _(Added 2026-08-07.)_ The environment holds only what is needed before the database can answer: the database connection, `TOKEN_ENCRYPTION_KEY` (the root of trust cannot live inside the store it seals), and process wiring (host, port, log level, trusted proxy IPs). Everything else — connector credentials, the Atlassian OAuth app registration, the public base URL, org limits, token TTLs, capability flags — lives in the database (`connector_configs`, `platform_settings`, `tenant_settings`), administered at runtime through org-admin APIs and cached briefly at read sites. A fresh deployment boots on two variables and is configured from inside.
20. **Two queues, one contract, swappable carriers.** _(Added 2026-08-13; amends the single-consumer reading of #17.)_ Queue-like work goes through `@renkei/queue`, a broker-agnostic contract (pull-consume with a delivery lease, ack/nack, retry with backoff, per-message **ordering keys**, and a dead-letter store with requeue) whose Postgres adapter carries it today — a RabbitMQ/Kafka adapter could replace it without touching a producer or consumer. Two queues exist because the workloads differ in payload size, latency profile, and reprocessing needs: `events` (webhook/interactive traffic, consumed by `apps/worker`'s interactive process) and `embedding_jobs` (every ingest-time call to the org-configured embeddings endpoint — chunk-and-embed ingestion, index deletes/purges, asynchronous enrichment back-fill — consumed by `embeddings-worker.ts`). Each queue has its own `*_dead_letters` table: exhausted messages MOVE there and can be requeued for reprocessing once the fault is fixed. Claims take row locks (`FOR UPDATE SKIP LOCKED`), so **either consumer scales horizontally** — messages sharing an ordering key (a mailbox's index writes, one subscription's delta rounds, one room's messages) are delivered strictly in order, one at a time, across any number of instances, while distinct keys drain in parallel. Ingestion-heavy handlers enqueue `knowledge/*` jobs instead of embedding inline, so a slow or hung embeddings endpoint can never delay a reply, and a mailbox rebuild is per-item jobs rather than one monolith that outlives the delivery lease.

## Open questions

None blocking — the vision-level decisions are made. What remains is design-level detail to be worked out per phase: how per-user auth flows through delegated A2A tasks, the classification taxonomy and how labels get assigned (provider metadata vs. rules vs. classifiers), and the token-vault choice flagged in Phase 0. Resolved since the last revision: the ACL-verification approach (#18), the process topology (#17), the tenancy question (#5), and the capability registry's interface shape — it now exists in code (`@renkei/capability-registry`: declared `CapabilityDescriptor`s filtered through the three gates of Decision #12, enforced at MCP tool registration via `withCapabilityGate`, with org-wide read-only mode as the first capability flag). The two enforcement gates likewise exist as typed primitives (`@renkei/gates`: the `verifyAccess`/`AccessVerifier` retrieval gate with default-deny orchestration, and the disclosure gate with most-restrictive-wins policy evaluation), ahead of their Phase 1–2 consumers as Phase 0 requires. The identity spine now exists in code: the `identities` table maps (tenant, OIDC subject) → email + display name, upserted from the id_token's claims at every sign-in — recorded identity, never authorization; the gates still verify live with the provider, the spine only tells them who to ask about. Its first consumer is `search_knowledge` (Phase 2's MCP gateway v1): retrieval verifies the calling user's provider access by their recorded email, and a subject with no recorded email fails closed. Per-provider linked accounts (Microsoft UPN, Atlassian account id) attach to the same key as those connectors arrive.
