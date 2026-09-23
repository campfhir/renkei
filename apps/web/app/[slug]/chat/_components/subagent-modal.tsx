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

import { useEffect, useMemo, useState } from 'react';
import Modal from '@/components/modal';
import { LoadingLine } from '@/components/skeleton';
import { chatClient } from '@/lib/chat/client';
import type { SubagentRunView } from '@/lib/chat/subagent-runs';
import type { ChatBlock } from '@/lib/chat/views';
import Markdown from './markdown';
import { StepList, type WorkStep } from './message-list';

const POLL_MS = 3_000;

/** The transcript as the thread renders work: per model reply, its prose and its steps. */
function turnsOf(transcript: SubagentRunView['transcript']): { text: string; steps: WorkStep[] }[] {
  const results = new Map<string, Extract<ChatBlock, { type: 'tool_result' }>>();
  for (const message of transcript) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') results.set(block.toolUseId, block);
    }
  }
  const out: { text: string; steps: WorkStep[] }[] = [];
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
    out.push({ text: texts.join('\n\n'), steps });
  }
  return out;
}

function statusWord(run: SubagentRunView): string {
  switch (run.status) {
    case 'running':
      return 'working';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
  }
}

export default function SubagentModal({
  tenantId,
  chatId,
  toolUseId,
  onClose,
}: {
  tenantId: string;
  chatId: string;
  toolUseId: string;
  onClose: () => void;
}) {
  const [run, setRun] = useState<SubagentRunView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      const result = await chatClient.getSubagentRun(tenantId, chatId, toolUseId);
      if (cancelled) return;
      if (result.data) {
        setRun(result.data.run);
        setError(null);
        if (result.data.run.status === 'running') timer = setTimeout(() => void load(), POLL_MS);
      } else {
        setError(
          result.error === 'No such sub-agent run'
            ? 'This sub-agent’s run was not recorded — it ran before runs were kept, or its turn was removed.'
            : (result.error ?? 'The sub-agent’s run could not be read.')
        );
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tenantId, chatId, toolUseId]);

  const turns = useMemo(() => (run ? turnsOf(run.transcript) : []), [run]);

  return (
    <Modal title="Sub-agent" onClose={onClose} size="wide">
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
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
          </p>
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
