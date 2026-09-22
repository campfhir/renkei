/**
 * The server side of a widget card's two callbacks into the app: the
 * confirm button's `tools/call` (bridge.ts's `callTool`, proxied by the
 * host component through here) and the card's `ui/update-model-context`
 * (recorded as a chat note so the next turn's model sees what the person
 * decided — lib/code/notes.ts's pattern, for a widget instead of the code
 * pane).
 *
 * `confirmWidgetTool` is the security boundary: the browser names a tool
 * and arguments, but a card is Renkei's own bundle (mcp-widgets/), not
 * arbitrary content, and the one thing worth enforcing server-side is the
 * MCP Apps contract itself — only a tool `_meta.ui.visibility` marks
 * app-only may be reached this way, exactly as an external MCP Apps host
 * (Claude Desktop) would restrict it. The minted token is further
 * allow-listed to that one tool name, so even a bug in the appOnly check
 * could not reach anything else.
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
import { getActiveTurn } from './turns';
import { internalMcpEndpoint } from './internal-origin';
import type { ChatMessageView } from './views';

const CALL_TTL_SECONDS = 5 * 60;
const MODEL_CONTEXT_MAX_CHARS = 4_000;

export type ConfirmWidgetToolResult =
  { ok: true; result: McpToolResult } | { ok: false; reason: 'not-a-card-tool' | 'call-failed' };

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
  }
): Promise<ConfirmWidgetToolResult> {
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
 * Append the card's `ui/update-model-context` text as a note row — the
 * thread shows it as a small line (segment.ts reads any 'note' row as
 * `kind: 'person'`) and the next turn's history carries it, same as
 * lib/code/notes.ts's rows. Refused while a turn is running, same reason:
 * the runner is the only writer of a turn's own rows then.
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
      message: {
        id: inserted.id,
        turnId: null,
        seq: inserted.seq,
        role: 'user',
        kind: 'note',
        status: 'complete',
        blocks: [{ type: 'text', text }],
        llmModelId: null,
        provider: null,
        model: null,
        stopReason: null,
        usage: null,
        error: null,
        createdAt: inserted.createdAt.toISOString(),
        attachments: [],
      },
    };
  });
}
