/**
 * The server side of a widget card's two callbacks into the app: the
 * confirm button's `tools/call` (bridge.ts's `callTool`, proxied by the
 * host component through here) and the card's `ui/update-model-context`
 * (what the person decided, recorded as a chat note — lib/code/notes.ts's
 * pattern, for a widget instead of the code pane — AND the model's cue to
 * reply: a decision on a card is the person's turn, so the note opens a
 * turn of its own rather than waiting for them to type something).
 *
 * `confirmWidgetTool` is the security boundary: the browser names a tool
 * and arguments, but a card is Renkei's own bundle (mcp-widgets/), not
 * arbitrary content, and the one thing worth enforcing server-side is the
 * MCP Apps contract itself — only a tool `_meta.ui.visibility` marks
 * app-only may be reached this way, exactly as an external MCP Apps host
 * (Claude Desktop) would restrict it. The minted token is further
 * allow-listed to that one tool name, so even a bug in the appOnly check
 * could not reach anything else.
 *
 * A third callback, `ui/report-decision` (bridge.ts), is what makes a card's
 * "already decided" receipt durable across devices instead of living only
 * in the browser that clicked the button (ui.ts's rememberDone/recallDone,
 * localStorage): `recordWidgetDecision` writes it to `chat_widget_decisions`,
 * keyed by the same `state_key` the card already used for its own local
 * receipt, and `confirmWidgetTool` checks that same key BEFORE running a
 * confirm tool a second time — a device that opens the chat after another
 * device already decided a non-idempotent action (send an email, create an
 * issue) must never re-run it, only show the receipt.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  HttpMcpClient,
  mintRunToken,
  revokeRunToken,
  type McpToolResult,
} from '@renkei/mcp-client';
import { listAvailableTools } from '@/lib/mcp-tools/tool-catalog';
import { insertMessage } from './messages';
import { startChatTurn, type StartedTurn } from './start-turn';
import { getActiveTurn } from './turns';
import { internalMcpEndpoint } from './internal-origin';
import type { ChatMessageView, WidgetDecisionState } from './views';

const CALL_TTL_SECONDS = 5 * 60;
const MODEL_CONTEXT_MAX_CHARS = 4_000;
const MAX_STATE_KEY_CHARS = 255;

export type ConfirmWidgetToolResult =
  | { ok: true; result: McpToolResult }
  | { ok: false; reason: 'not-a-card-tool' | 'call-failed' }
  | { ok: false; reason: 'already-decided'; decision: WidgetDecisionState };

/**
 * Run a card's confirm tool as the signed-in owner. Refuses anything not
 * flagged app-only for this tenant/subject right now — a tool that lost
 * its connector, or was never app-only, answers `not-a-card-tool` rather
 * than running.
 */
export async function confirmWidgetTool(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    subject: string;
    roles: string[];
    name: string;
    arguments: Record<string, unknown>;
    /**
     * The card's own persistence key (ui.ts's rememberDone key), when the
     * card sends one along with its `tools/call` (bridge.ts's `callTool`).
     * A decision already recorded under it refuses the call rather than
     * running the tool again — the one guard against a second device
     * double-acting on a confirm tool that is not idempotent.
     */
    stateKey?: string;
  }
): Promise<ConfirmWidgetToolResult> {
  // Checked first, and on its own: whether this exact card was already
  // decided is a plain fact about `chat_widget_decisions`, independent of
  // whatever the tool catalog says right now — a connector that dropped
  // after the fact must never turn "already decided" into "not a card
  // tool" (or, worse, into `not-a-card-tool` masking a stale catalog read
  // that would otherwise have let a second run through).
  if (input.stateKey) {
    const existing = await getWidgetDecision(db, input.tenantId, input.stateKey);
    if (existing) return { ok: false, reason: 'already-decided', decision: existing };
  }

  const catalog = await listAvailableTools(input.tenantId, input.subject, { roles: input.roles });
  const descriptor = catalog.find((entry) => entry.name === input.name);
  if (!descriptor?.appOnly) return { ok: false, reason: 'not-a-card-tool' };

  const token = await mintRunToken(db, {
    tenantId: input.tenantId,
    subject: input.subject,
    agentId: null,
    ttlSeconds: CALL_TTL_SECONDS,
    roles: input.roles,
    tools: [input.name],
  });
  const mcp = new HttpMcpClient(internalMcpEndpoint(input.tenantId), token, {
    clientName: 'renkei-chat-widget',
  });
  try {
    await mcp.initialize();
    const result = await mcp.callTool(input.name, input.arguments);
    return { ok: true, result };
  } catch {
    return { ok: false, reason: 'call-failed' };
  } finally {
    await revokeRunToken(db, token);
  }
}

/**
 * What a card's `ui/update-model-context` came to: the note row the
 * thread shows, and the turn it opened — null when the note was recorded
 * but no reply could start (no usable model; a code project's history
 * chat), so the person's decision is on the record either way.
 */
export type WidgetModelContextOutcome = { message: ChatMessageView; turn: StartedTurn | null };

/**
 * Record the card's `ui/update-model-context` text and let the model take
 * its turn on it. The text lands as a user-role row of kind 'note' (the
 * thread shows it as a small line; segment.ts reads any 'note' row as
 * `kind: 'person'`) that is ALSO the user row of a new turn — the same
 * path as Send (start-turn.ts), so the model answers the decision at once
 * ("Sent." / "Created OPS-99, anything else?") instead of only learning of
 * it whenever the person next writes. Without this the card's receipt was
 * the end of the exchange and the person had to send another message to
 * get the model to carry on.
 *
 * Refused while a turn is running, same as any note: the runner is the
 * only writer of a turn's own rows then. When a turn cannot start for a
 * reason that is not the chat's state — no model configured, the model
 * unusable, the chat a code project's history — the note is still
 * appended on its own so the decision is not lost, and `turn` is null.
 */
export async function recordWidgetModelContext(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    session: { subject: string; roles: string[] };
    chatId: string;
    text: string;
    defer?: (task: () => Promise<void>) => void;
  }
): Promise<
  ({ ok: true } & WidgetModelContextOutcome) | { ok: false; reason: 'turn-running' | 'failed' }
> {
  const text = input.text.trim().slice(0, MODEL_CONTEXT_MAX_CHARS);
  if (!text) return { ok: false, reason: 'failed' };
  const started = await startChatTurn(db, {
    tenantId: input.tenantId,
    session: input.session,
    chatId: input.chatId,
    text,
    kind: 'note',
    ...(input.defer ? { defer: input.defer } : {}),
  });
  if (started.ok) {
    return {
      ok: true,
      message: noteView({
        id: started.val.userMessageId,
        turnId: started.val.turnId,
        seq: started.val.userMessageSeq,
        createdAt: started.val.userMessageCreatedAt,
        text,
      }),
      turn: started.val,
    };
  }
  switch (started.err.type) {
    case 'ALREADY_RUNNING':
      return { ok: false, reason: 'turn-running' };
    case 'NO_MODEL':
    case 'MODEL_ERROR':
    case 'HISTORY': {
      const appended = await appendWidgetModelContext(db, {
        tenantId: input.tenantId,
        chatId: input.chatId,
        text,
      });
      return appended.ok ? { ok: true, message: appended.message, turn: null } : appended;
    }
    default:
      return { ok: false, reason: 'failed' };
  }
}

/**
 * Append the card's `ui/update-model-context` text as a note row on its
 * own, with no turn — `recordWidgetModelContext`'s fallback when a reply
 * cannot start. Refused while a turn is running, same reason: the runner
 * is the only writer of a turn's own rows then.
 */
export async function appendWidgetModelContext(
  db: Kysely<DB>,
  input: { tenantId: string; chatId: string; text: string }
): Promise<
  { ok: true; message: ChatMessageView } | { ok: false; reason: 'turn-running' | 'failed' }
> {
  const text = input.text.trim().slice(0, MODEL_CONTEXT_MAX_CHARS);
  if (!text) return { ok: false, reason: 'failed' };
  return db.transaction().execute(async (trx) => {
    await trx
      .selectFrom('chats')
      .select('id')
      .where('id', '=', input.chatId)
      .forUpdate()
      .executeTakeFirst();
    if (await getActiveTurn(trx, input.chatId)) return { ok: false, reason: 'turn-running' };
    const inserted = await insertMessage(trx, {
      tenantId: input.tenantId,
      chatId: input.chatId,
      turnId: null,
      role: 'user',
      kind: 'note',
      status: 'complete',
      blocks: [{ type: 'text', text }],
    });
    if (!inserted) return { ok: false, reason: 'failed' };
    return {
      ok: true,
      message: noteView({
        id: inserted.id,
        turnId: null,
        seq: inserted.seq,
        createdAt: inserted.createdAt.toISOString(),
        text,
      }),
    };
  });
}

/** The thread's view of a note row, as the page would read it back. */
function noteView(row: {
  id: string;
  turnId: string | null;
  seq: number;
  createdAt: string;
  text: string;
}): ChatMessageView {
  return {
    id: row.id,
    turnId: row.turnId,
    seq: row.seq,
    role: 'user',
    kind: 'note',
    status: 'complete',
    blocks: [{ type: 'text', text: row.text }],
    llmModelId: null,
    provider: null,
    model: null,
    stopReason: null,
    usage: null,
    error: null,
    createdAt: row.createdAt,
    attachments: [],
  };
}

/**
 * A card's decision, reported once it finishes (bridge.ts's
 * `reportDecision`, sent from every widget bundle's `finishDone`). Both
 * Confirm and Cancel funnel through `finishDone`, so this is the one write
 * path for either outcome.
 *
 * `ON CONFLICT DO NOTHING`: the first report for a `state_key` wins. A
 * second report — a race between two devices, or a retry — arrives after
 * whatever it reported (a tool call, or nothing, for Cancel) already
 * happened once; overwriting the row would rewrite a receipt the model and
 * the chat may already have reacted to.
 */
export async function recordWidgetDecision(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    chatId: string;
    subject: string;
    stateKey: string;
    decision: 'confirmed' | 'cancelled';
    state: WidgetDecisionState;
  }
): Promise<{ ok: true } | { ok: false; reason: 'invalid' }> {
  const stateKey = input.stateKey.trim().slice(0, MAX_STATE_KEY_CHARS);
  if (!stateKey) return { ok: false, reason: 'invalid' };
  await db
    .insertInto('chat_widget_decisions')
    .values({
      tenant_id: input.tenantId,
      chat_id: input.chatId,
      state_key: stateKey,
      decision: input.decision,
      state: JSON.stringify(input.state),
      decided_by: input.subject,
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'state_key']).doNothing())
    .execute();
  return { ok: true };
}

/** One card's decision, by its own persistence key — `confirmWidgetTool`'s guard. */
export async function getWidgetDecision(
  db: Kysely<DB>,
  tenantId: string,
  stateKey: string
): Promise<WidgetDecisionState | null> {
  const row = await db
    .selectFrom('chat_widget_decisions')
    .select(['state'])
    .where('tenant_id', '=', tenantId)
    .where('state_key', '=', stateKey)
    .executeTakeFirst();
  return row ? widgetDecisionStateOf(row.state) : null;
}

/**
 * Every decision recorded for one chat, by `state_key` — chat-view.ts's
 * batch read, merged onto each message's `tool_result` blocks at render
 * time so a chat opened on a new device shows every card's real state at
 * once rather than one lookup per card.
 */
export async function listWidgetDecisions(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string
): Promise<Map<string, WidgetDecisionState>> {
  const rows = await db
    .selectFrom('chat_widget_decisions')
    .select(['state_key', 'state'])
    .where('tenant_id', '=', tenantId)
    .where('chat_id', '=', chatId)
    .execute();
  const out = new Map<string, WidgetDecisionState>();
  for (const row of rows) {
    const state = widgetDecisionStateOf(row.state);
    if (state) out.set(row.state_key, state);
  }
  return out;
}

function widgetDecisionStateOf(value: unknown): WidgetDecisionState | null {
  let parsed: unknown = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record: { icon?: unknown; headline?: unknown; detail?: unknown; links?: unknown } = parsed;
  if (record.icon !== 'sent' && record.icon !== 'cancelled') return null;
  if (typeof record.headline !== 'string') return null;
  const links = Array.isArray(record.links)
    ? record.links.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const link: { label?: unknown; href?: unknown } = entry;
        return typeof link.label === 'string' && typeof link.href === 'string'
          ? [{ label: link.label, href: link.href }]
          : [];
      })
    : [];
  return {
    icon: record.icon,
    headline: record.headline,
    ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
    ...(links.length > 0 ? { links } : {}),
  };
}
