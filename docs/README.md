# Documentation index

This folder holds two kinds of documents:

- **Point-in-time design docs** (`*-design.md`, plus the vendor OpenAPI specs and PDFs) — proposals written before or during a specific piece of work. They capture the reasoning behind a decision at the time it was made and are **not** kept in sync with the code afterward. Treat them as historical context, not a live reference.
- **As-built references** (below) — describe what the code actually does today. These are meant to be kept current.

## As-built references

| Doc | Covers |
| --- | --- |
| [`architecture.md`](./architecture.md) | System topology: the `apps/*` processes, the `packages/*` shared modules, how an event or an MCP call actually flows through them, and how this differs from the aspirational plan in `RENKEI.md`. Start here. |
| [`mcp-gateway.md`](./mcp-gateway.md) | The MCP tool surface: tenant routing, the two OAuth/OIDC layers, the tool registry and per-user capability gating, the admin UI, and the cards/actionable-items feed. |
| [`connectors.md`](./connectors.md) | Every connector package (`packages/connector-*`): what provider it wraps, its auth model, its data contract (what's indexed vs. live-queried vs. never stored), and its `verifyAccess` implementation. |
| [`knowledge-and-security.md`](./knowledge-and-security.md) | The knowledge layer (chunking, embeddings, pgvector search), the two hard-coded enforcement gates (live ACL verification and the disclosure gate), the capability registry's three-gate per-user projection, and redaction. |
| [`agents.md`](./agents.md) | The agent system: the step-document model, the `needsApproval` gate and `ask_person` questions, triggers, runs, memory, LLM provider resolution, and the `apps/worker-agents` execution engine. |
| [`chat.md`](./chat.md) | The first-party chat: its tables, how a turn runs and streams (live channel vs. database snapshot), the per-chat toolset and the loopback call into the MCP gateway, attachments and the object store, projects with shared files/instructions/memory, prompt libraries, and read-only sharing. |

## Product vision vs. current code

[`RENKEI.md`](../RENKEI.md) is the product plan — the target architecture, the phased roadmap, and the numbered "Decisions" that govern how the system should be built. It is **not** a description of what exists today; large parts of the plan (the monorepo split, several connectors, the agent system) have since been built, and some of what's built goes beyond what `RENKEI.md` describes (the approval/question gate on agent steps, Web Push notifications). The docs in this folder describe the code as it stands; `RENKEI.md` describes where it's headed. Where they disagree, the code — and these docs — win for "what does it do today," and `RENKEI.md`'s Decisions win for "why was it built this way."

The root [`README.md`](../README.md) is also stale in places (it still frames the repo as "a multi-tenant Jira MCP server"); `architecture.md` has the current module list.

## A note to future agents (human and AI)

**This folder went undocumented for a long time** — as of writing, zero `apps/*` or `packages/*` directory had a README, and the root README undersold the codebase by a wide margin. Don't let these docs rot the same way:

- When you add a package, a connector, a new MCP tool family, or change how a major subsystem works (the agent step model, the approval/question flow, the knowledge/ACL gates, the queue topology), update the relevant file here in the same change, not as a follow-up.
- When you notice a doc here is wrong, fix it — don't work around the discrepancy silently.
- Prefer updating an existing as-built doc over creating a new fragment; only add a new file when a doc for that area genuinely doesn't exist yet.
- Design docs (`*-design.md`) are append-only history — write a new one for a new proposal rather than editing an old one to match what shipped, but do update the as-built doc it fed into.
