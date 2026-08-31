/**
 * Writing down what a run did, for the person whose agent it was.
 *
 * ## Best-effort, and never throws
 *
 * The posture `webex/sent-ledger.ts` states and `agent-run-failed.ts`
 * repeats: the thing already happened. An agent that filed a ticket has
 * filed it whether or not we managed to record that, so a failed write here
 * is a WARN and the run carries on. Notification is reach, never the record
 * — the record is the run itself.
 *
 * ## Preferences are applied at WRITE time
 *
 * A category somebody switched off produces no row at all, rather than a
 * row the reader hides. Two consequences worth being explicit about:
 *
 *   - the table stays small, which is what makes a 14-day window generous
 *     rather than a storage problem;
 *   - turning a category ON is NOT retroactive. The preferences page has to
 *     say so, or it reads as a bug the first time somebody flips a switch
 *     and yesterday stays empty.
 *
 * Preferences are read ONCE per run, beside the org settings, rather than
 * per tool call — a foreach loop over forty issues should not be forty
 * cache lookups and, on a cold cache, forty queries.
 *
 * ## The row and the push are two different promises
 *
 * The `agent_notifications` row is what the poll-based UI (the toast pile,
 * the nav badge, the notifications page) reads — it only ever updates while
 * a tab is open and running. `@renkei/notifications`' `sendPush` is the
 * other half: it wakes a device with NOTHING open, iOS chief among them,
 * where a suspended tab simply cannot poll at all. Both come from this one
 * write, and the push is fired without being awaited — a slow or
 * unreachable push service must never add its latency to a run's step.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { resolveAct } from '@renkei/tool-outcomes';
import { getNotificationPrefs, wantsAct, type NotificationPrefs } from '@renkei/user-prefs';
import { parseEncryptionKey } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { logger } from './logger';
import type { McpClient, McpToolInfo } from './mcp-client';

/**
 * Best-effort owner notifications through the run's own MCP tools — the
 * shared arm behind every email/WebEx alert an agent sends its owner
 * (approval and question cards, run outcomes, individual acts). Reusing the
 * run's own tools rather than a bespoke Graph/WebEx client means org
 * read-only mode, redaction and scope-gated registration all apply for
 * free: an unconnected or under-scoped channel just isn't in `toolsByName`,
 * so it degrades to a note, never a failed run.
 */
export interface DelivererToolCallRecord {
  tool: string;
  argsPreview: string;
  resultPreview: string;
  isError: boolean;
  durationMs: number;
}

const PREVIEW_CHARS = 4_000;
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}
function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
    .join('\n');
}

export function notificationDeliverer(mcp: McpClient, toolsByName: Map<string, McpToolInfo>) {
  const toolCalls: DelivererToolCallRecord[] = [];
  const notes: string[] = [];
  const deliver = async (
    channel: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<void> => {
    if (!toolsByName.has(tool)) {
      notes.push(`${channel} skipped — the "${tool}" skill is not connected.`);
      return;
    }
    const startedAt = Date.now();
    let result: Awaited<ReturnType<McpClient['callTool']>>;
    try {
      result = await mcp.callTool(tool, args);
    } catch (error) {
      result = {
        content: [
          {
            type: 'text',
            text: `The tool could not be reached: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
        meta: {},
      };
    }
    toolCalls.push({
      tool,
      argsPreview: clip(JSON.stringify(args), PREVIEW_CHARS),
      resultPreview: clip(textOf(result), PREVIEW_CHARS),
      isError: result.isError,
      durationMs: Date.now() - startedAt,
    });
    if (result.isError) notes.push(`${channel} could not be delivered.`);
  };
  const deliverOwnerNotifications = async (input: {
    email: boolean;
    webex: boolean;
    heading: string;
    body: string;
    ownerEmail: string | undefined;
  }): Promise<void> => {
    if (input.email) {
      if (!input.ownerEmail) {
        notes.push('Email skipped — no email address is recorded for you.');
      } else {
        await deliver('Email', 'outlook_send_mail', {
          to: [input.ownerEmail],
          subject: input.heading,
          body: input.body,
        });
      }
    }
    if (input.webex) {
      await deliver('WebEx note', 'webex_note_to_self', {
        markdown: `**${input.heading}**\n\n${input.body}`,
      });
    }
  };
  return { toolCalls, notes, deliverOwnerNotifications };
}

export interface NotifierContext {
  tenantId: string;
  /** Who reads this: the run's owner. */
  subject: string;
  agentId: string;
  agentName: string;
  runId: string;
  prefs: NotificationPrefs;
  /**
   * For firing email/WebEx alerts through the run's own tools. Absent on
   * the paths that build a notifier without an active MCP session (a run
   * that never got that far) — those never call `.act()`, the only method
   * that needs them, so absence there is inert rather than a bug.
   */
  mcp?: McpClient;
  toolsByName?: Map<string, McpToolInfo>;
  ownerEmail: string | undefined;
}

export interface Notifier {
  /** One act an agent performed. `kind` is the registration stamp. */
  act(
    tool: string,
    kind: 'read' | 'act' | null,
    meta: Record<string, unknown>,
    stepId: string | null
  ): Promise<void>;
  runStarted(): Promise<void>;
  runFinished(status: 'succeeded' | 'failed', error: string | null): Promise<void>;
}

/** The whole reason this never throws — one place, one swallow. */
async function write(
  db: Kysely<DB>,
  context: NotifierContext,
  row: {
    kind: string;
    category?: string | null;
    connector?: string | null;
    tool?: string | null;
    entity?: string | null;
    headline: string;
    refId?: string | null;
    refUrl?: string | null;
    stepId?: string | null;
  }
): Promise<void> {
  const id = randomUUID();
  try {
    await db
      .insertInto('agent_notifications')
      .values({
        id,
        tenant_id: context.tenantId,
        subject: context.subject,
        kind: row.kind,
        category: row.category ?? null,
        connector: row.connector ?? null,
        tool: row.tool ?? null,
        entity: row.entity ?? null,
        headline: row.headline,
        ref_id: row.refId ?? null,
        ref_url: row.refUrl ?? null,
        agent_id: context.agentId,
        agent_name: context.agentName,
        run_id: context.runId,
        step_id: row.stepId ?? null,
      })
      .execute();
  } catch (error) {
    logger.warn('could not record a notification for run {runId}', {
      component: 'worker-agents/notifications',
      tenantId: context.tenantId,
      runId: context.runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // Fire-and-forget, deliberately not awaited: a push service's own latency
  // must never add to a step's. The row above is the record; this is only
  // reach, same distinction the file's own header draws.
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (keyResult.ok) {
    void sendPush(
      db,
      context.tenantId,
      context.subject,
      keyResult.val,
      {
        title: row.headline,
        body: context.agentName || 'An agent',
        tag: context.runId && row.tool ? `${context.runId}:${row.tool}` : id,
        refUrl: row.refUrl ?? null,
      },
      { log: (message, meta) => logger.warn(message, meta) }
    );
  }
}

export function createNotifier(db: Kysely<DB>, context: NotifierContext): Notifier {
  return {
    async act(tool, kind, meta, stepId) {
      const resolved = resolveAct(tool, kind, meta);
      // Null means the tool only read. Nothing to tell anyone.
      if (!resolved) return;

      const wantsApp = wantsAct(context.prefs, resolved.connector, resolved.category, 'app');
      const wantsEmail = wantsAct(context.prefs, resolved.connector, resolved.category, 'email');
      const wantsWebex = wantsAct(context.prefs, resolved.connector, resolved.category, 'webex');
      if (!wantsApp && !wantsEmail && !wantsWebex) return;

      if (wantsApp) {
        await write(db, context, {
          kind: 'act',
          category: resolved.category,
          connector: resolved.connector,
          tool,
          entity: resolved.entity,
          headline: resolved.headline,
          refId: resolved.id,
          refUrl: resolved.url,
          stepId,
        });
      }

      if ((wantsEmail || wantsWebex) && context.mcp && context.toolsByName) {
        const { deliverOwnerNotifications } = notificationDeliverer(context.mcp, context.toolsByName);
        await deliverOwnerNotifications({
          email: wantsEmail,
          webex: wantsWebex,
          heading: resolved.headline,
          body: `“${context.agentName}” — ${resolved.headline}.`,
          ownerEmail: context.ownerEmail,
        });
      }
    },

    async runStarted() {
      if (!context.prefs.runStarted) return;
      await write(db, context, {
        kind: 'run_started',
        headline: `“${context.agentName}” started`,
      });
    },

    async runFinished(status, error) {
      const wanted = status === 'failed' ? context.prefs.runFailed : context.prefs.runFinished;
      if (!wanted) return;
      await write(db, context, {
        kind: status === 'failed' ? 'run_failed' : 'run_finished',
        headline:
          status === 'failed'
            ? `“${context.agentName}” failed${error ? `: ${error}` : ''}`
            : `“${context.agentName}” finished`,
      });
    },
  };
}

/** Read one run's preferences once, beside the org settings. */
export async function notifierFor(
  db: Kysely<DB>,
  context: Omit<NotifierContext, 'prefs'>
): Promise<Notifier> {
  const prefs = await getNotificationPrefs(context.tenantId, context.subject);
  return createNotifier(db, { ...context, prefs });
}
