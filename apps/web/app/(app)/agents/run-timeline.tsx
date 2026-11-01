/**
 * The run timeline both audiences read — a pure render of whatever the
 * runs-view projection handed the page. A run is one conversation, so the
 * timeline is its TURNS: what the agent said, which tools it called and
 * what came back, the batches of changes it staged (shown at the turn that
 * staged them, with who accepted them and how each action went), and how
 * it finished.
 *
 * REDACTION IS NOT DONE HERE: a turn without `detail` (or a batch without
 * its actions) renders as hidden, and this component has no way to
 * un-hide anything, which is the point of doing the split at the query
 * seam.
 */

import { friendlyToolName } from '@/lib/tool-name';
import { statusLabel } from '@/lib/agents/run-labels';
import type { ActionBatchView, AttemptView, RunDetail } from '@/lib/agents/runs-view';
import { formatDurationMs } from '@/lib/duration';
import { toolResultText } from '@/lib/agents/tool-result';
import { isRecord } from '@renkei/guards';

function statusTone(status: string): string {
  switch (status) {
    case 'succeeded':
    case 'completed':
    case 'accepted':
      return 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300';
    case 'failed':
      return 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
    case 'running':
    case 'executing':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300';
    // A graceful "nothing to do" — neutral on purpose: not the green of
    // work done, and emphatically not the red of a failure.
    case 'stopped':
      return 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
    // Parked on a human decision — amber says "your move", not "broken".
    case 'waiting':
    case 'proposed':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  }
}

export function StatusPill({ status, errorKind }: { status: string; errorKind?: string | null }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(status)}`}>
      {statusLabel(status, errorKind)}
    </span>
  );
}

/**
 * Detail strings can be huge and token-dense (saved JSON, id lists) — they
 * are informative, not the point of the page. Long values render clamped
 * behind a "Show all" toggle; `break-all` keeps unbroken tokens (ids,
 * base64) from stretching the page sideways. Pure CSS (`group-open`), so
 * this stays a server component.
 */
const CLAMP_CHARS = 280;

function ClampedText({ label, text }: { label: string; text: string }) {
  if (text.length <= CLAMP_CHARS) {
    return (
      <p className="whitespace-pre-wrap break-words">
        {label ? <span className="font-medium">{label}:</span> : null} {text}
      </p>
    );
  }
  return (
    <details className="group">
      <summary className="cursor-pointer list-none">
        {label ? <span className="font-medium">{label}:</span> : null}{' '}
        <span className="break-all group-open:hidden">{text.slice(0, CLAMP_CHARS)}…</span>
        <span className="ml-1 whitespace-nowrap text-blue-600 dark:text-blue-400">
          <span className="group-open:hidden">
            Show all ({text.length.toLocaleString()} characters)
          </span>
          <span className="hidden group-open:inline">Show less</span>
        </span>
      </summary>
      <p className="mt-0.5 whitespace-pre-wrap break-all">{text}</p>
    </details>
  );
}

/** How a finishing turn said the run ended. */
function finishWording(finish: unknown): string | null {
  switch (finish) {
    case 'done':
      return 'Finished — the goal was met.';
    case 'nothing_to_do':
      return 'Finished — there was nothing to do for this input.';
    case 'failed':
      return 'Gave up — the agent could not reach its goal.';
    default:
      return null;
  }
}

/** Who (or what) let a batch through, or why it never ran. */
function batchVerdict(batch: ActionBatchView): string {
  switch (batch.status) {
    case 'proposed':
      return 'Waiting for your go-ahead.';
    case 'declined':
      return 'Declined — none of these were made.';
    case 'expired':
      return 'Nobody accepted it in time — none of these were made.';
    case 'accepted':
    case 'executing':
      return batch.acceptedBy === 'auto'
        ? 'Accepted automatically — being carried out.'
        : 'Accepted — being carried out.';
    case 'completed':
      return batch.acceptedBy === 'auto'
        ? 'Accepted automatically and carried out.'
        : 'Accepted and carried out.';
    default:
      return batch.status;
  }
}

function reviewReasonWording(reason: string | null): string | null {
  switch (reason) {
    case 'high-risk':
      return 'Needed a person: it includes a high-risk action.';
    case 'policy':
      return 'Needed a person: your organization requires it for this run.';
    default:
      return null;
  }
}

function outcomeTone(outcome: string): string {
  if (outcome === 'succeeded') return 'text-green-700 dark:text-green-400';
  if (outcome === 'failed') return 'text-red-600 dark:text-red-400';
  return 'text-gray-500';
}

export function BatchBlock({ batch }: { batch: ActionBatchView }) {
  const reason = reviewReasonWording(batch.reviewReason);
  return (
    <div
      data-testid="staged-batch"
      className="rounded-md border border-amber-200 bg-amber-50/40 p-2 dark:border-amber-900 dark:bg-amber-950/20"
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-gray-800 dark:text-gray-200">
          Proposed {batch.actionCount} change{batch.actionCount === 1 ? '' : 's'}
        </span>
        <StatusPill status={batch.status} />
      </p>
      {batch.summary !== undefined ? (
        <>
          {batch.summary ? (
            <p className="mt-1 whitespace-pre-wrap break-words">{batch.summary}</p>
          ) : null}
          <ol className="mt-1 space-y-1">
            {(batch.actions ?? []).map((action, index) => {
              const result = batch.results?.[index];
              return (
                <li
                  key={`${index}-${action.tool}`}
                  className="rounded bg-white/70 p-1.5 dark:bg-gray-900/60"
                >
                  <p>
                    <span className="mr-1 text-gray-400">{index + 1}.</span>
                    <span className="font-medium" title={action.tool}>
                      {friendlyToolName(action.tool, null)}
                    </span>
                    {result ? (
                      <span className={`ml-1.5 ${outcomeTone(result.outcome)}`}>
                        {result.outcome}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-gray-500">{action.reason}</p>
                  <details>
                    <summary className="cursor-pointer text-blue-600 dark:text-blue-400">
                      Arguments
                    </summary>
                    <p className="mt-0.5 break-all font-mono text-[0.65rem]">
                      {JSON.stringify(action.args)}
                    </p>
                  </details>
                  {result?.text ? <ClampedText label="Result" text={result.text} /> : null}
                </li>
              );
            })}
          </ol>
          {batch.comment ? <p className="mt-1 italic">Note: “{batch.comment}”</p> : null}
        </>
      ) : (
        <p className="mt-1 italic text-gray-400">Details hidden.</p>
      )}
      <p className="mt-1 text-gray-600 dark:text-gray-400">{batchVerdict(batch)}</p>
      {reason ? <p className="text-gray-500">{reason}</p> : null}
    </div>
  );
}

function TurnDetail({ turn, batches }: { turn: AttemptView; batches: ActionBatchView[] }) {
  if (turn.redacted) {
    return (
      <div className="mt-1 space-y-1 text-xs">
        <p className="italic text-gray-400 dark:text-gray-500">
          Details are shown only for runs that failed.
        </p>
        {batches.map((batch) => (
          <BatchBlock key={batch.id} batch={batch} />
        ))}
      </div>
    );
  }
  const detail = isRecord(turn.detail) ? turn.detail : {};
  const toolCalls = (Array.isArray(detail.toolCalls) ? detail.toolCalls : []).flatMap(
    (call: unknown): Record<string, unknown>[] => (isRecord(call) ? [call] : [])
  );
  const modelCalls = (Array.isArray(detail.modelCalls) ? detail.modelCalls : []).flatMap(
    (call: unknown) =>
      isRecord(call) && typeof call.durationMs === 'number' ? [call.durationMs] : []
  );
  const modelMs = modelCalls.reduce((sum, ms) => sum + ms, 0);
  const pause = isRecord(detail.pause) ? detail.pause : null;
  const finish = finishWording(detail.finish);
  return (
    <div className="mt-1 space-y-1 text-xs text-gray-600 dark:text-gray-400">
      {typeof detail.opening === 'string' && detail.opening ? (
        <details>
          <summary className="cursor-pointer font-medium">
            {turn.attempt === 1 ? 'What the run started with' : 'Note to the agent'}
          </summary>
          <p className="mt-0.5 whitespace-pre-wrap break-words">{detail.opening}</p>
        </details>
      ) : null}
      {isRecord(detail.compaction) &&
      typeof detail.compaction.summary === 'string' &&
      typeof detail.compaction.through === 'number' ? (
        <div
          data-testid="turn-compaction"
          className="rounded border border-dashed border-gray-300 p-2 dark:border-gray-700"
        >
          <p className="font-medium">
            {detail.compaction.through === 1 ? 'Turn 1' : `Turns 1–${detail.compaction.through}`}{' '}
            folded into notes to fit the model&rsquo;s context
          </p>
          <ClampedText label="" text={detail.compaction.summary} />
        </div>
      ) : null}
      {typeof detail.llmSummary === 'string' && detail.llmSummary ? (
        <ClampedText label="" text={detail.llmSummary} />
      ) : null}
      {toolCalls.length > 0 ? (
        <ul className="space-y-1">
          {toolCalls.map((call, index) => {
            const free = call.free === true;
            const resultText = toolResultText(detail, call);
            const tool = typeof call.tool === 'string' ? call.tool : 'tool';
            return (
              <li
                key={index}
                className={`rounded p-2 ${free ? 'bg-gray-50/60 opacity-70 dark:bg-gray-900/40' : 'bg-gray-50 dark:bg-gray-900'}`}
              >
                <p className="font-mono">
                  <span title={tool}>{tool}</span>
                  {free ? (
                    <span className="ml-1 rounded bg-gray-200 px-1 font-sans text-[0.65rem] text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                      built-in
                    </span>
                  ) : null}
                  {typeof call.staged === 'number' ? (
                    <span className="ml-1 font-sans text-gray-500">({call.staged} staged)</span>
                  ) : null}
                  {call.isError === true ? (
                    <span className="ml-1 text-red-600 dark:text-red-400">(error)</span>
                  ) : null}
                  {typeof call.durationMs === 'number' && call.durationMs > 0 ? (
                    <span className="ml-1 text-gray-400">{call.durationMs}ms</span>
                  ) : null}
                </p>
                {typeof call.argsPreview === 'string' && call.argsPreview !== '{}' ? (
                  <p className="mt-0.5 break-all font-mono text-[0.65rem]">{call.argsPreview}</p>
                ) : null}
                {resultText ? <ClampedText label="" text={resultText} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {batches.map((batch) => (
        <BatchBlock key={batch.id} batch={batch} />
      ))}
      {pause?.kind === 'question' && typeof pause.message === 'string' ? (
        <ClampedText label="Asked you" text={pause.message} />
      ) : null}
      {finish ? (
        <p
          className={`font-medium ${detail.finish === 'failed' ? 'text-red-700 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}
        >
          {finish}
        </p>
      ) : null}
      {typeof detail.result === 'string' && detail.result ? (
        <ClampedText label="Result" text={detail.result} />
      ) : null}
      {modelCalls.length > 0 ? (
        <p className="text-gray-500" data-model-calls>
          {formatDurationMs(modelMs)} waiting on the model
        </p>
      ) : null}
    </div>
  );
}

export function RunTimeline({ run }: { run: RunDetail }) {
  const wallMs =
    run.startedAt && run.finishedAt
      ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
      : null;
  // A batch belongs to the turn that staged it; one whose turn this
  // audience cannot see still shows (its status is content-free).
  const batchesByTurn = new Map<number, ActionBatchView[]>();
  for (const batch of run.batches) {
    batchesByTurn.set(batch.turn, [...(batchesByTurn.get(batch.turn) ?? []), batch]);
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="run-times">
        {run.attempts.length} turn{run.attempts.length === 1 ? '' : 's'} · active time{' '}
        {formatDurationMs(run.activeMs)}
        {wallMs !== null ? ` · wall time ${formatDurationMs(wallMs)}` : ''}
        {' — time spent waiting on you is not counted against the run.'}
      </p>
      <ol className="space-y-3">
        {run.attempts.map((turn) => (
          <li
            key={`${turn.stepId}-${turn.attempt}`}
            className="rounded-md border border-gray-200 p-3 dark:border-gray-800"
          >
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium" data-testid="turn-heading">
                Turn {turn.attempt}
              </span>
              <StatusPill status={turn.status} />
              {turn.toolCallCount > 0 ? (
                <span className="text-xs text-gray-400">
                  {turn.toolCallCount} tool call{turn.toolCallCount === 1 ? '' : 's'}
                </span>
              ) : null}
            </p>
            <TurnDetail turn={turn} batches={batchesByTurn.get(turn.attempt) ?? []} />
          </li>
        ))}
        {run.attempts.length === 0 ? (
          <li className="text-sm text-gray-500 dark:text-gray-400">
            Nothing ran{run.error ? ` — ${run.error}` : '.'}
          </li>
        ) : null}
      </ol>
    </div>
  );
}
