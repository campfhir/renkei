'use client';

/**
 * A sub-agent's run, opened from its card in the thread: the task it was
 * given and the instructions it worked under, how far it got, its report,
 * and its whole transcript — every model reply and every tool call with
 * its result, listed the way the thread lists the chat's own work. This
 * is the conversation the chat never carried (lib/chat/subagent-runs.ts):
 * kept for a person to read, never fed back to a model. While the run
 * is still going the page asks again every few seconds.
 */

import { useEffect, useMemo, useReducer, useRef } from 'react';
import Modal from '@/components/modal';
import { LoadingLine } from '@/components/skeleton';
import { chatClient } from '@/lib/chat/client';
import type { SubagentRunView } from '@/lib/chat/subagent-runs';
import type { ChatBlock } from '@/lib/chat/views';
import { formatDurationMs } from '@/lib/duration';
import Markdown from './markdown';
import { useElapsedMs } from './use-elapsed';
import { StepList, type WorkStep } from './message-list';
import {
  canStop,
  initialSubagentModal,
  keepsAsking,
  showsStop,
  statusWord,
  stopLabel,
  subagentModalReducer,
} from './subagent-modal.model';

const POLL_MS = 3_000;

interface TranscriptTurn {
  text: string;
  steps: WorkStep[];
  /** How long this model call took, when the run kept it. */
  durationMs: number | null;
}

/** The transcript as the thread renders work: per model reply, its prose and its steps. */
function turnsOf(transcript: SubagentRunView['transcript']): TranscriptTurn[] {
  const results = new Map<string, Extract<ChatBlock, { type: 'tool_result' }>>();
  for (const message of transcript) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') results.set(block.toolUseId, block);
    }
  }
  const out: TranscriptTurn[] = [];
  for (const message of transcript) {
    if (message.role !== 'assistant') continue;
    const steps: WorkStep[] = [];
    const texts: string[] = [];
    for (const block of message.blocks) {
      switch (block.type) {
        case 'text':
          if (block.text.trim()) texts.push(block.text);
          break;
        case 'thinking':
          if (block.thinking.trim()) steps.push({ kind: 'thinking', text: block.thinking });
          break;
        case 'redacted_thinking':
          steps.push({ kind: 'redacted' });
          break;
        case 'tool_use':
          steps.push({ kind: 'call', block, result: results.get(block.id) ?? null });
          break;
        default:
          break;
      }
    }
    out.push({ text: texts.join('\n\n'), steps, durationMs: message.durationMs ?? null });
  }
  return out;
}

export default function SubagentModal({
  chatId,
  toolUseId,
  notStarted = false,
  isOwner = false,
  onClose,
}: {
  chatId: string;
  toolUseId: string;
  /**
   * The delegating call has no result yet and its turn is still going: a
   * call that acts runs after the ones before it, so its run row does not
   * exist until its turn comes. No record then means "not started", not
   * "not recorded".
   */
  notStarted?: boolean;
  /** The chat's owner may stop a sub-agent that is still working; a viewer only reads. */
  isOwner?: boolean;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(subagentModalReducer, initialSubagentModal);
  const { run, error, queued } = state;
  const notStartedRef = useRef(notStarted);
  notStartedRef.current = notStarted;
  const asking = keepsAsking(state);
  // Which read this is: the first, then one more each time a poll comes due.
  const [tick, nextTick] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    let cancelled = false;
    void chatClient.getSubagentRun(chatId, toolUseId).then((result) => {
      if (cancelled) return;
      if (result.data) dispatch({ type: 'loaded', run: result.data.run });
      else {
        dispatch({
          type: 'loadFailed',
          message: result.error,
          notStarted: notStartedRef.current,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, toolUseId, tick]);

  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(nextTick, POLL_MS);
    return () => clearTimeout(timer);
    // Re-armed by each read it starts, for as long as there is something to follow.
  }, [asking, tick]);

  const stop = async () => {
    if (!canStop(state, isOwner)) return;
    dispatch({ type: 'stopPressed' });
    const result = await chatClient.stopSubagentRun(chatId, toolUseId);
    if (result.error) dispatch({ type: 'stopRefused', message: result.error });
    else {
      dispatch({ type: 'stopAsked' });
      nextTick();
    }
  };

  const turns = useMemo(() => (run ? turnsOf(run.transcript) : []), [run]);
  // Counted from the run's own start to its finish, or to now while it works.
  const elapsedMs = useElapsedMs(
    run ? Date.parse(run.startedAt) : null,
    run?.finishedAt ? Date.parse(run.finishedAt) : null,
    run?.status === 'running'
  );

  return (
    <Modal title="Sub-agent" onClose={onClose} size="wide">
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : !run && queued ? (
        <LoadingLine label="Waiting for this sub-agent to start — it runs after the call before it…" />
      ) : !run ? (
        <LoadingLine label="Reading the sub-agent’s run…" />
      ) : (
        <div className="max-h-[75vh] space-y-4 overflow-y-auto text-sm">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
            <span
              className={`rounded-full px-1.5 py-0.5 font-medium ${
                run.status === 'running'
                  ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300'
                  : run.status === 'completed'
                    ? 'bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300'
                    : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
              }`}
            >
              {statusWord(run)}
            </span>
            {elapsedMs !== null ? (
              <span data-subagent-elapsed>
                {run.status === 'running' ? 'running for' : 'ran for'} {formatDurationMs(elapsedMs)}
              </span>
            ) : null}
            <span>
              {run.steps} of {run.maxSteps} model calls · {run.toolCalls} tool call
              {run.toolCalls === 1 ? '' : 's'}
            </span>
            <span>
              {run.usage.inputTokens.toLocaleString()} in /{' '}
              {run.usage.outputTokens.toLocaleString()} out tokens
            </span>
            {run.model ? (
              <span data-subagent-model title={`${run.model.provider} ${run.model.model}`}>
                on {run.model.label ?? run.model.model}
              </span>
            ) : null}
            {run.readOnly ? <span>read-only</span> : null}
            {run.error ? (
              <span className="text-amber-700 dark:text-amber-400">{run.error}</span>
            ) : null}
            {showsStop(state, isOwner) ? (
              <button
                type="button"
                data-subagent-stop
                onClick={() => void stop()}
                disabled={!canStop(state, isOwner)}
                className="ml-auto rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
              >
                {stopLabel(state)}
              </button>
            ) : null}
          </p>
          {state.stopError ? (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              The sub-agent was not stopped: {state.stopError}
            </p>
          ) : null}
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase text-gray-400">Task</h3>
            <p className="whitespace-pre-wrap break-words">{run.task}</p>
          </section>
          {run.instructions ? (
            <details className="chat-fold">
              <summary>Instructions from the orchestrator</summary>
              <p className="whitespace-pre-wrap break-words">{run.instructions}</p>
            </details>
          ) : null}
          {run.report ? (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase text-gray-400">
                Report — what the chat received
              </h3>
              <div className="rounded-md border border-gray-200 px-3 py-2 dark:border-gray-800">
                <Markdown text={run.report} />
              </div>
            </section>
          ) : null}
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase text-gray-400">
              Transcript — never part of the chat’s context
            </h3>
            {turns.length === 0 ? (
              <p className="text-xs text-gray-500">
                {run.status === 'running'
                  ? 'The transcript is kept when the sub-agent finishes; until then, the counts above are live.'
                  : 'No transcript was kept for this run.'}
              </p>
            ) : (
              <ol className="space-y-3">
                {turns.map((turn, index) => (
                  <li
                    key={index}
                    className="rounded-md border border-gray-200 px-3 py-2 dark:border-gray-800"
                  >
                    <p className="mb-1 text-[11px] font-semibold uppercase text-gray-400">
                      Model call {index + 1}
                      {turn.durationMs !== null ? (
                        <span className="ml-1 font-normal normal-case" data-model-call-duration>
                          · {formatDurationMs(turn.durationMs)}
                        </span>
                      ) : null}
                    </p>
                    {turn.text ? <Markdown text={turn.text} /> : null}
                    {turn.steps.length > 0 ? (
                      <div className={turn.text ? 'mt-2' : ''}>
                        <StepList steps={turn.steps} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
