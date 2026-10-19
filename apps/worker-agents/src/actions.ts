/**
 * The action executor: runs an accepted action batch, then hands its run
 * back to the agent.
 *
 * This is the ONLY path by which an agent run changes anything. The agent
 * stages tool calls (stage_actions → an `agent_action_batches` row); a
 * person accepts the batch on its card, or auto-accept does where the org
 * allows it; and this job — a separate `{ batchId }` message on the agents
 * queue, under its own token naming just the batch's tools — makes the
 * calls. The agent's own token never carries an act tool, so it cannot do
 * any of this itself.
 *
 *  - In order, one at a time; the first failure stops the batch and every
 *    later action is recorded as skipped (they were planned as a series).
 *  - Each outcome is written to the batch as it lands. A batch found
 *    'executing' on redelivery was interrupted mid-call: the action that
 *    was running is recorded as failed with its outcome unknown and the
 *    rest skipped — never made a second time.
 *  - A batch whose run was canceled meanwhile is not executed; a cancel
 *    that lands mid-batch stops it before the next action.
 *  - Done, the run is re-enqueued; the engine reads the batch and returns
 *    the report as the agent's stage_actions result. The run's clock was
 *    stopped the whole time.
 */

import { sql, type Kysely } from 'kysely';
import type { DB, Json } from '@renkei/db';
import {
  ACTION_RESULT_CHARS,
  clipActionResult,
  parseStoredActions,
  parseStoredResults,
  type ActionResult,
} from '@renkei/agents';
import type { QueueProducer } from '@renkei/queue';
import { toolKindOf } from '@renkei/tool-outcomes';
import type { McpClient, McpToolResult } from './mcp-client';
import { AgentMcpClient } from './mcp-client';
import { NOTIFIER_TOOLS, notifierFor } from './notifications';
import { mintRunToken, revokeRunToken } from './token';
import { logger } from './logger';

/** The executor's token lives this long: a batch is at most twenty calls. */
const TOKEN_TTL_SECONDS = 30 * 60;
/** An 'executing' batch untouched for this long was abandoned by its executor. */
const ABANDONED_AFTER_MS = 2 * 60_000;

export interface ActionsDeps {
  db: Kysely<DB>;
  webBaseUrl: string;
  /** Where the run goes back to once the batch has an outcome. */
  runProducer: QueueProducer;
  createMcpClient?: (token: string, webBaseUrl: string, runId?: string) => McpClient;
  mintToken?: typeof mintRunToken;
  revokeToken?: typeof revokeRunToken;
  now?: () => number;
}

/** Thrown to have the queue retry later: nothing about the batch is wrong. */
class TransientFailure extends Error {}

function textOf(result: McpToolResult): string {
  return result.content
    .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
    .join('\n');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

export function createActionsHandler(deps: ActionsDeps) {
  const db = deps.db;
  const createClient =
    deps.createMcpClient ??
    ((token: string, base: string, runId?: string) =>
      new AgentMcpClient(`${base.replace(/\/+$/, '')}/api/mcp/mcp`, token, {
        ...(runId ? { runId } : {}),
      }));
  const mint = deps.mintToken ?? mintRunToken;
  const revoke = deps.revokeToken ?? revokeRunToken;
  const now = deps.now ?? (() => Date.now());

  async function wakeRun(runId: string, agentId: string): Promise<void> {
    const enqueued = await deps.runProducer.enqueue({
      source: `agents:${agentId}`,
      type: 'run',
      payload: { runId },
      orderingKey: `agent:${agentId}`,
    });
    if (!enqueued.ok) throw new TransientFailure('could not hand the run back');
  }

  return async function handleActions(message: { payload: Json }): Promise<void> {
    const payload: { batchId?: unknown } =
      typeof message.payload === 'object' &&
      message.payload !== null &&
      !Array.isArray(message.payload)
        ? message.payload
        : {};
    if (typeof payload.batchId !== 'string') {
      logger.error('actions job without batchId; dropping', {
        component: 'worker-agents/actions',
      });
      return;
    }
    const batch = await db
      .selectFrom('agent_action_batches as b')
      .innerJoin('agent_runs as r', 'r.id', 'b.run_id')
      .innerJoin('agents as a', 'a.id', 'b.agent_id')
      .select([
        'b.id',
        'b.run_id',
        'b.agent_id',
        'b.owner_subject',
        'b.status',
        'b.actions',
        'b.results',
        'b.updated_at',
        'r.status as run_status',
        'r.cancel_requested_at',
        'a.name as agent_name',
      ])
      .where('b.id', '=', payload.batchId)
      .executeTakeFirst();
    if (!batch) {
      logger.warn('actions job for unknown batch {batchId}; dropping', {
        component: 'worker-agents/actions',
        batchId: payload.batchId,
      });
      return;
    }
    // Settled already (a duplicate message): make sure the run heard.
    if (batch.status === 'completed' || batch.status === 'declined' || batch.status === 'expired') {
      if (batch.run_status === 'waiting') await wakeRun(batch.run_id, batch.agent_id);
      return;
    }
    if (batch.status !== 'accepted' && batch.status !== 'executing') return;

    // A run that ended (canceled while the batch waited in the queue) must
    // not act after the fact.
    const runOver =
      batch.cancel_requested_at !== null ||
      ['succeeded', 'failed', 'canceled', 'stopped'].includes(batch.run_status);
    if (runOver) {
      await db
        .updateTable('agent_action_batches')
        .set({
          status: 'expired',
          comment: 'The run ended before the batch could be carried out.',
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', batch.id)
        .where('status', 'in', ['accepted', 'executing'])
        .execute();
      return;
    }

    const actions = parseStoredActions(batch.actions);
    const results: ActionResult[] = parseStoredResults(batch.results);

    if (batch.status === 'executing') {
      // Someone else's claim. Fresh: they are working on it — come back
      // later. Stale: they died mid-batch, and the action they were on has
      // an unknown outcome.
      if (now() - new Date(batch.updated_at).getTime() < ABANDONED_AFTER_MS) {
        throw new TransientFailure('the batch is being executed elsewhere');
      }
      const interrupted = actions[results.length];
      if (interrupted) {
        results.push({
          tool: interrupted.tool,
          outcome: 'failed',
          text: 'Interrupted while it was being made — its outcome is unknown. Check before trying it again.',
          durationMs: 0,
        });
      }
    } else {
      const claimed = await db
        .updateTable('agent_action_batches')
        .set({ status: 'executing', started_at: sql`NOW()`, updated_at: sql`NOW()` })
        .where('id', '=', batch.id)
        .where('status', '=', 'accepted')
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows ?? 0) === 0) {
        throw new TransientFailure('the batch was claimed concurrently');
      }
    }

    const saveResults = async () => {
      await db
        .updateTable('agent_action_batches')
        .set({ results: JSON.stringify(results), updated_at: sql`NOW()` })
        .where('id', '=', batch.id)
        .execute();
    };

    const failedEarlier = () => results.some((result) => result.outcome !== 'succeeded');
    let canceledMidway = false;
    if (results.length < actions.length && !failedEarlier()) {
      const token = await mint(db, {
        subject: batch.owner_subject,
        agentId: batch.agent_id,
        ttlSeconds: TOKEN_TTL_SECONDS,
        tools: [...new Set([...actions.map((action) => action.tool), ...NOTIFIER_TOOLS])],
      });
      try {
        const mcp = createClient(token, deps.webBaseUrl, batch.run_id);
        await mcp.initialize();
        const toolsByName = new Map((await mcp.listTools()).map((tool) => [tool.name, tool]));
        const notifier = await notifierFor(db, {
          subject: batch.owner_subject,
          agentId: batch.agent_id,
          agentName: batch.agent_name,
          runId: batch.run_id,
          mcp,
          toolsByName,
          ownerEmail: undefined,
        });
        for (let index = results.length; index < actions.length; index += 1) {
          if (failedEarlier()) break;
          // A cancel that lands mid-batch stops it before the next action:
          // what was made stays made, the rest is never made.
          const live = await db
            .selectFrom('agent_runs')
            .select(['cancel_requested_at', 'status'])
            .where('id', '=', batch.run_id)
            .executeTakeFirst();
          if (!live || live.cancel_requested_at !== null || live.status === 'canceled') {
            canceledMidway = true;
            break;
          }
          const action = actions[index];
          if (!toolsByName.has(action.tool)) {
            results.push({
              tool: action.tool,
              outcome: 'failed',
              text: `The tool "${action.tool}" is not available to the agent's owner right now.`,
              durationMs: 0,
            });
            await saveResults();
            break;
          }
          // Recorded as started before the call: a crash from here on
          // reads as "outcome unknown", never as "not yet made".
          await db
            .updateTable('agent_action_batches')
            .set({ updated_at: sql`NOW()` })
            .where('id', '=', batch.id)
            .execute();
          const startedAt = now();
          let result: McpToolResult;
          try {
            result = await mcp.callTool(action.tool, action.args);
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
          const text = textOf(result);
          results.push({
            tool: action.tool,
            outcome: result.isError ? 'failed' : 'succeeded',
            text:
              clipActionResult(text, ACTION_RESULT_CHARS) ||
              (result.isError ? 'The tool reported an error.' : 'Done.'),
            durationMs: now() - startedAt,
          });
          await saveResults();
          if (!result.isError) {
            void notifier.act(action.tool, toolKindOf(result.meta), result.meta, null);
          } else {
            logger.warn('staged action {tool} failed for run {runId}', {
              component: 'worker-agents/actions',
              runId: batch.run_id,
              agentId: batch.agent_id,
              tool: action.tool,
              error: clip(text, 500),
            });
          }
        }
      } finally {
        await revoke(db, token);
      }
    }

    // Whatever was not reached is skipped: the batch was planned as a series.
    for (let index = results.length; index < actions.length; index += 1) {
      results.push({
        tool: actions[index].tool,
        outcome: 'skipped',
        text: canceledMidway
          ? 'Not made: the run was canceled.'
          : 'Not made: an earlier action in this batch failed.',
        durationMs: 0,
      });
    }
    await db
      .updateTable('agent_action_batches')
      .set({
        status: 'completed',
        results: JSON.stringify(results),
        finished_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .where('id', '=', batch.id)
      .execute();
    logger.info('batch {batchId} executed for run {runId}: {summary}', {
      component: 'worker-agents/actions',
      batchId: batch.id,
      runId: batch.run_id,
      summary: results.map((result) => `${result.tool}=${result.outcome}`).join(', '),
    });
    await wakeRun(batch.run_id, batch.agent_id);
  };
}
