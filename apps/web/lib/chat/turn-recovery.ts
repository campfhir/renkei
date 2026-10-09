/**
 * Picking up chat turns that lost their process.
 *
 * A turn runs in the web process that took the Send (start-turn.ts), and
 * that process can go away mid-reply: a deploy, a scale-in, a crash. The
 * runner's own shutdown (turn-runner.ts, on lib/shutdown.ts's signal)
 * leaves the row `running` and marked `suspended_at`; a crash leaves it
 * `running` with a heartbeat that stops. Either way the rows say exactly
 * where the turn was, and this module is what reads them and carries on:
 *
 *   `startTurnRecovery` — a sweep on every web process (instrumentation.ts)
 *     that claims such turns (turns.ts's claimResumableTurns: a row-locked
 *     UPDATE, so replicas never take the same one), ends the ones resumed
 *     too many times already, and resumes the rest here.
 *   `planResume` — pure: given the turn's rows, what the loop was doing.
 *     Streaming a reply → that half-written row goes and the model is
 *     asked again. Running a tool round → the calls with no result are
 *     answered as interrupted (never re-run by the runner itself: a call
 *     that acts may have half-happened, and the model is the one to check
 *     before repeating it). Between rounds → carry on. A reply that had
 *     finished → the turn completes as it stood. The seed (`resumeSeedOf`)
 *     is the loop's counters, read back off the same rows.
 *   `resumeChatTurn` — applies the plan to the rows, writes a note into
 *     the thread (a `nudge` row, so the person sees why the reply paused
 *     and the model knows what it is picking up), and runs the turn again
 *     through start-turn.ts's executeChatTurn with the seed.
 *
 * What a resumed turn cannot get back: a permission ask that was open
 * (the call is answered as interrupted; the model asks again if it still
 * wants it), a sub-agent's progress (its run is marked interrupted, the
 * delegation likewise), and the exact wall-clock spent waiting on
 * permission (the deadline counts from the turn's start).
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { resolveAgentLlm, type LlmContentBlock } from '@renkei/agent-llm';
import { getOrgSettings } from '@renkei/settings';
import { logger } from '@/lib/logger';
import { isShuttingDown, onShutdown } from '@/lib/shutdown';
import { CODE_DELEGATE_TOOL } from '@/lib/code/delegate';
import { TASK_COMPLETE_TOOL } from './auto-mode';
import { insertMessage, listTurnMessages, type StoredMessage } from './messages';
import { cipherAsOwner } from './chat-keys';
import { unavailableCipher } from './content-crypto';
import { executeChatTurn } from './start-turn';
import { getChatRow } from './store';
import { interruptSubagentRunsOfTurn } from './subagent-runs';
import { friendlyLlmError, type TurnResumeSeed } from './turn-runner';
import { claimResumableTurns, finishTurn, interruptExhaustedTurns, type TurnRow } from './turns';
import { sql } from 'kysely';

/** How often each web process looks for turns to pick up. */
export const RECOVERY_SWEEP_MS = 10_000;
/**
 * A heartbeat older than this is a dead process. The runner touches the
 * row every two seconds — while preparing (start-turn.ts) and while
 * working (turn-runner.ts's flush timer) — so a healthy turn never comes
 * near it, and a crash is picked up within about a minute.
 */
export const STALE_HEARTBEAT_SECONDS = 60;
/** Resumes per turn before it is ended instead: a turn that keeps losing its process is not a restart to ride out. */
export const MAX_TURN_RESUMES = 3;
const CLAIM_BATCH = 10;

export const RESUME_EXHAUSTED_ERROR =
  'The reply was interrupted by a service restart several times and did not finish.';

/** What the thread shows, and the model reads, where a resumed turn picks up. */
export const RESUME_NOTE_TEXT =
  'The service restarted while this reply was in progress; it picks up from here. Anything that was in flight when it stopped may or may not have happened — check before repeating a step that changes something.';

/** What the model is told in place of a result for a call the restart cut off. */
export const TOOL_CALL_INTERRUPTED_RESULT =
  'The service restarted while this call was running, so its result was lost and its effect is unknown. Check the current state before repeating it if it changes anything; a call that only reads can simply be made again.';

type ToolUse = Extract<LlmContentBlock, { type: 'tool_use' }>;

export type ResumePlan =
  /** The loop was streaming a reply into this row: drop it and ask again. */
  | { kind: 'restream'; messageId: string }
  /** A tool round was in flight: these calls have no result on the rows. */
  | { kind: 'answer'; toolUses: ToolUse[] }
  /** Between rounds: the next reply's row was never opened. */
  | { kind: 'continue' }
  /** The reply had finished before the process went; the turn just needs closing. */
  | { kind: 'finish'; status: 'completed' | 'failed' | 'canceled' | 'interrupted' };

function toolUsesOf(blocks: LlmContentBlock[]): ToolUse[] {
  return blocks.filter((block): block is ToolUse => block.type === 'tool_use');
}

/** The turn's rows, oldest first, are the whole record of where it was. */
export function planResume(rows: StoredMessage[]): ResumePlan {
  const last = rows[rows.length - 1];
  if (!last) return { kind: 'continue' };
  if (last.role !== 'assistant') return { kind: 'continue' };
  if (last.status === 'streaming') return { kind: 'restream', messageId: last.id };
  if (last.status === 'complete') {
    const uses = toolUsesOf(last.blocks);
    return uses.length > 0
      ? { kind: 'answer', toolUses: uses }
      : { kind: 'finish', status: 'completed' };
  }
  // The loop had already flushed the row's ending and was closing the
  // turn when the process went.
  return {
    kind: 'finish',
    status: last.status === 'failed' || last.status === 'canceled' ? last.status : 'interrupted',
  };
}

/** A prelude step's tool_use (turn-runner.ts) is the runner's, not a model call. */
function isPreludeRow(row: StoredMessage): boolean {
  return toolUsesOf(row.blocks).some((use) => use.id.startsWith('prelude_'));
}

/** The loop's counters, as the rows record them — see TurnResumeSeed. */
export function resumeSeedOf(rows: StoredMessage[], startedAt: Date): TurnResumeSeed {
  const assistantRows = rows.filter((row) => row.role === 'assistant');
  const modelCalls = assistantRows.filter((row) => row.status === 'complete' && !isPreludeRow(row));
  const nameOfCall = new Map<string, string>();
  for (const row of assistantRows) {
    for (const use of toolUsesOf(row.blocks)) nameOfCall.set(use.id, use.name);
  }
  const taskDone = rows.some(
    (row) =>
      row.role === 'user' &&
      row.blocks.some(
        (block) =>
          block.type === 'tool_result' &&
          block.isError !== true &&
          nameOfCall.get(block.toolUseId) === TASK_COMPLETE_TOOL
      )
  );
  let inputTokens = 0;
  let outputTokens = 0;
  for (const row of assistantRows) {
    inputTokens += row.usage?.inputTokens ?? 0;
    outputTokens += row.usage?.outputTokens ?? 0;
  }
  return {
    startedAt: startedAt.getTime(),
    iterations: modelCalls.length,
    continues: rows.filter((row) => row.kind === 'nudge').length,
    silentRetries: 0,
    spawnedSubagent: [...nameOfCall.values()].includes(CODE_DELEGATE_TOOL),
    taskDone,
    inputTokens,
    outputTokens,
  };
}

/**
 * The claimed turn, carried on in this process. Every path settles the
 * row: resumed and running again, or finished with a status.
 */
export async function resumeChatTurn(db: Kysely<DB>, turn: TurnRow): Promise<void> {
  const log = (
    message: string,
    fields: Record<string, unknown> = {},
    level: 'info' | 'warn' = 'info'
  ) =>
    logger[level](message, {
      component: 'chat/turn-recovery',
      chatId: turn.chatId,
      turnId: turn.id,
      resumeCount: turn.resumeCount,
      ...fields,
    });
  const end = async (
    status: 'completed' | 'failed' | 'canceled' | 'interrupted',
    error: string | null,
    seed: TurnResumeSeed
  ) => {
    await finishTurn(db, turn.id, {
      status,
      error,
      iterations: seed.iterations,
      inputTokens: seed.inputTokens,
      outputTokens: seed.outputTokens,
    });
    await db
      .updateTable('chat_messages')
      .set({ status: status === 'completed' ? 'complete' : status, updated_at: sql<Date>`NOW()` })
      .where('turn_id', '=', turn.id)
      .where('status', '=', 'streaming')
      .execute();
    await interruptSubagentRunsOfTurn(db, turn.id);
    log('orphaned chat turn ended as {status}', { status, error });
  };

  // No person is signed in for a resumed turn: the chat's rows are opened
  // and written as its owner (chat-keys.ts). A chat already gone leaves
  // the rows unopenable and the turn ends below either way.
  const chat = await getChatRow(db, turn.tenantId, turn.chatId);
  const cipher = chat ? await cipherAsOwner(db, 'chat', chat) : unavailableCipher('no-key');
  const rows = await listTurnMessages(db, turn.tenantId, turn.id, cipher);
  const seed = resumeSeedOf(rows, turn.startedAt);
  const plan = planResume(rows);

  // A sub-agent of the lost process reports to nobody now.
  await interruptSubagentRunsOfTurn(db, turn.id);

  if (turn.cancelRequestedAt) return end('canceled', null, seed);
  if (plan.kind === 'finish') return end(plan.status, turn.error, seed);

  if (!chat) return end('interrupted', 'The chat is gone.', seed);
  const llmResult = await resolveAgentLlm(db, turn.tenantId, turn.llmModelId);
  if (!llmResult.ok) {
    return end(
      'failed',
      llmResult.err.type === 'NO_MODEL'
        ? 'No model is configured for this organization.'
        : (llmResult.err.message ?? friendlyLlmError('provider_error')),
      seed
    );
  }
  const llm = llmResult.val;
  const roles =
    turn.runner?.roles ?? (await latestSessionRoles(db, turn.tenantId, chat.ownerSubject));
  const settingsResult = await getOrgSettings(turn.tenantId);

  // Reconcile the rows to a state the loop can start from: a results row
  // for the calls cut off, the note, and a fresh row for the next reply.
  if (plan.kind === 'restream') {
    await db.deleteFrom('chat_messages').where('id', '=', plan.messageId).execute();
  }
  if (plan.kind === 'answer') {
    const results: LlmContentBlock[] = plan.toolUses.map((use) => ({
      type: 'tool_result',
      toolUseId: use.id,
      content: TOOL_CALL_INTERRUPTED_RESULT,
      isError: true,
    }));
    const inserted = await insertMessage(db, {
      chatId: turn.chatId,
      turnId: turn.id,
      role: 'user',
      kind: 'tool_results',
      status: 'complete',
      blocks: results,
      cipher,
    });
    if (!inserted) return end('failed', 'The content encryption key is not configured.', seed);
  }
  const note = await insertMessage(db, {
    chatId: turn.chatId,
    turnId: turn.id,
    role: 'user',
    kind: 'nudge',
    status: 'complete',
    blocks: [{ type: 'text', text: RESUME_NOTE_TEXT }],
    cipher,
  });
  if (!note) return end('failed', 'The content encryption key is not configured.', seed);
  const assistant = await insertMessage(db, {
    chatId: turn.chatId,
    turnId: turn.id,
    role: 'assistant',
    kind: 'assistant',
    status: 'streaming',
    blocks: [],
    llmModelId: llm.modelConfigId,
    provider: llm.providerName,
    model: llm.model,
    cipher,
  });
  if (!assistant) return end('failed', 'The content encryption key is not configured.', seed);

  log('resuming an orphaned chat turn', {
    plan: plan.kind,
    interruptedCalls: plan.kind === 'answer' ? plan.toolUses.map((use) => use.name) : [],
    iterations: seed.iterations,
  });
  await executeChatTurn(db, {
    session: { subject: chat.ownerSubject, roles },
    chat: { ...chat, llmModelId: llm.modelConfigId },
    cipher,
    turnId: turn.id,
    assistantMessage: assistant,
    llm,
    thinkingBudget: turn.thinkingBudget,
    settings: settingsResult.ok ? settingsResult.val : null,
    voice: turn.runner?.voice === true,
    resume: { seed },
  });
}

/**
 * The roles a turn from before migration 129 ran under: the owner's most
 * recent session's. Empty when they have none, which offers the turn no
 * role-gated tool rather than guessing at one.
 */
async function latestSessionRoles(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<string[]> {
  const row = await db
    .selectFrom('sessions')
    .select('roles')
    .where('subject', '=', subject)
    .orderBy('last_used_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.roles ?? [];
}

/**
 * One pass: end the turns past their resume budget, claim the rest, and
 * resume each — not awaited, the way a Send's turn runs behind its
 * response. Returns how many were claimed, for the log and the tests.
 */
export async function recoverOrphanedTurns(db: Kysely<DB>): Promise<number> {
  if (isShuttingDown()) return 0;
  const exhausted = await interruptExhaustedTurns(db, {
    staleSeconds: STALE_HEARTBEAT_SECONDS,
    maxResumes: MAX_TURN_RESUMES,
    error: RESUME_EXHAUSTED_ERROR,
  });
  for (const id of exhausted) {
    await interruptSubagentRunsOfTurn(db, id);
    logger.warn('chat turn interrupted after {max} resumes', {
      component: 'chat/turn-recovery',
      turnId: id,
      max: MAX_TURN_RESUMES,
    });
  }
  const claimed = await claimResumableTurns(db, {
    staleSeconds: STALE_HEARTBEAT_SECONDS,
    maxResumes: MAX_TURN_RESUMES,
    limit: CLAIM_BATCH,
  });
  for (const turn of claimed) {
    void resumeChatTurn(db, turn).catch((error: unknown) => {
      logger.error('chat turn resume crashed: {message}', {
        component: 'chat/turn-recovery',
        chatId: turn.chatId,
        turnId: turn.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return claimed.length;
}

/**
 * The sweep, on this process for as long as it runs; stops itself on
 * shutdown so a process on its way out claims nothing. One pass at a
 * time — a slow pass skips a beat rather than piling up.
 */
export function startTurnRecovery(db: Kysely<DB>, intervalMs = RECOVERY_SWEEP_MS): () => void {
  let running = false;
  const tick = async () => {
    if (running || isShuttingDown()) return;
    running = true;
    try {
      await recoverOrphanedTurns(db);
    } catch (error) {
      logger.error('chat turn recovery sweep failed: {message}', {
        component: 'chat/turn-recovery',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  const stop = () => clearInterval(timer);
  const unsubscribe = onShutdown(stop);
  return () => {
    stop();
    unsubscribe();
  };
}
