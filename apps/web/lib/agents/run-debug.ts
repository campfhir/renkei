/**
 * A run rendered as paste-ready markdown — what the "Copy for debugging"
 * button on the run pages puts on the clipboard, written for handing to
 * Claude Code or another dev tool with zero cleanup.
 *
 * Works from the same RunDetail projection the page renders, so the
 * audience's redaction carries over untouched: a turn the projection
 * withheld content for is copied as hidden, not resurrected here.
 */

import { TOOL_RESULT_CHARS } from '@renkei/agents/run-prompts';
import { statusLabel } from '@/lib/agents/run-labels';
import { activityHeadline, runActivity } from '@/lib/agents/run-actions';
import type { AttemptView, RunDetail } from '@/lib/agents/runs-view';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Values printed once and elided everywhere after.
 *
 * The trigger's input is listed in full under "Trigger input", and then
 * AGAIN inside the run's opening message. Each long value is therefore
 * printed where it first appears and later occurrences become a pointer
 * back to it. Exact-substring replacement, no prompt parsing: a value
 * short enough to read inline is left alone, and a value the projection
 * clipped differently from the prompt simply does not match and stays.
 */
const ELIDE_MIN_CHARS = 300;

class SeenValues {
  private readonly entries: { value: string; note: string }[] = [];

  add(value: string, note: string): void {
    if (value.length < ELIDE_MIN_CHARS) return;
    if (this.entries.some((entry) => entry.value === value)) return;
    this.entries.push({ value, note });
  }

  /** The text with every seen value replaced; whether anything was. */
  elide(text: string): { text: string; elided: boolean } {
    let out = text;
    let elided = false;
    // Longest first, so a value that contains another is replaced whole.
    for (const entry of [...this.entries].sort((a, b) => b.value.length - a.value.length)) {
      if (!out.includes(entry.value)) continue;
      out = out
        .split(entry.value)
        .join(`[${entry.note} — ${entry.value.length} chars, shown above]`);
      elided = true;
    }
    return { text: out, elided };
  }
}

/**
 * What the trigger handed the run.
 *
 * First section after the header on purpose: when an agent misbehaves, the
 * answer is very often that it was given something other than what the
 * author pictured — a space NAME where a step wanted a room id, an empty
 * subject, a body that arrived truncated. Reading the turns without this is
 * reading half the problem.
 */
function initialStateLines(run: RunDetail, seen: SeenValues): string[] {
  if (run.initialStateRedacted) {
    return ['## Trigger input', '', '(hidden for this audience)', ''];
  }
  const state = run.initialState;
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return [];
  const entries = Object.entries(state);
  if (entries.length === 0) return [];
  const lines = ['## Trigger input', ''];
  for (const [key, value] of entries) {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    seen.add(String(rendered ?? ''), `trigger.${key}`);
    // Multi-line values (an email body) are indented so the markdown stays
    // one list rather than collapsing into the surrounding prose.
    lines.push(`- ${key}: ${String(rendered ?? '').replace(/\n/g, '\n    ')}`);
  }
  lines.push('');
  return lines;
}

/** Every tool call in order — the "what did it touch" half of the paste. */
function activityLines(run: RunDetail): string[] {
  const activity = runActivity(run);
  const lines = ['## What it did', '', activityHeadline(activity), ''];
  if (activity.toolsUsed.length > 0) {
    lines.push(`Tools used: ${activity.toolsUsed.join(', ')}`, '');
  }
  for (const action of activity.actions) {
    const state = action.failed ? ' — FAILED' : action.notMade ? ' — not made' : '';
    lines.push(
      `${action.ordinal}. ${action.kind === 'change' ? 'CHANGE' : 'read'} ${action.tool}${state} — turn ${action.turn}` +
        (action.durationMs !== null ? ` (${action.durationMs}ms)` : '')
    );
    if (action.argsPreview) lines.push(`   args: ${action.argsPreview}`);
  }
  if (activity.hiddenAttempts > 0) {
    lines.push(`(${activity.hiddenAttempts} turn(s) had their calls hidden for this audience)`);
  }
  lines.push('');
  return lines;
}

/** What the run executed — its instructions and tools as snapshotted. */
function definitionLines(run: RunDetail): string[] {
  if (!run.definition) return [];
  return [
    '## Agent instructions (as snapshotted for this run)',
    '',
    '```markdown',
    run.definition.instructions,
    '```',
    '',
    `Tools: ${run.definition.tools.length > 0 ? run.definition.tools.join(', ') : 'none'}`,
    '',
  ];
}

/** The batches this run staged, with each action's outcome. */
function batchLines(run: RunDetail): string[] {
  if (run.batches.length === 0) return [];
  const lines = ['## Staged actions', ''];
  for (const batch of run.batches) {
    lines.push(
      `### Turn ${batch.turn}: ${batch.status}` +
        (batch.acceptedBy
          ? ` (accepted ${batch.acceptedBy === 'auto' ? 'automatically' : 'by the owner'})`
          : '') +
        (batch.reviewReason ? ` — needed a person: ${batch.reviewReason}` : '')
    );
    if (!batch.actions) {
      lines.push(`(${batch.actionCount} action(s), hidden for this audience)`, '');
      continue;
    }
    if (batch.summary) lines.push(batch.summary);
    if (batch.comment) lines.push(`Owner's comment: ${batch.comment}`);
    batch.actions.forEach((action, index) => {
      const result = batch.results?.[index];
      lines.push(
        `${index + 1}. ${action.tool}${result ? ` — ${result.outcome}` : ''} — ${action.reason}`,
        `   args: ${JSON.stringify(action.args)}`,
        ...(result ? [`   result: ${result.text.replace(/\n/g, '\n   ')}`] : [])
      );
    });
    lines.push('');
  }
  return lines;
}

function turnLines(attempt: AttemptView, seen: SeenValues): string[] {
  const heading =
    `### Turn ${attempt.attempt}: ${statusLabel(attempt.status)}` +
    (attempt.outcome ? ` (${attempt.outcome})` : '') +
    (attempt.toolCallCount > 0 ? ` — ${attempt.toolCallCount} tool call(s) billed` : '');
  if (attempt.redacted) return [heading, '(details hidden for this audience)', ''];

  const lines = [heading];
  const detail: Record<string, unknown> =
    typeof attempt.detail === 'object' && attempt.detail !== null && !Array.isArray(attempt.detail)
      ? attempt.detail
      : {};
  if (str(detail.opening)) {
    const opening = seen.elide(str(detail.opening));
    lines.push(
      opening.elided
        ? 'Message the turn opened with (long values already shown above are replaced by a pointer):'
        : 'Message the turn opened with (verbatim):',
      '```text',
      opening.text,
      '```'
    );
  }
  if (str(detail.llmSummary)) lines.push(`Model said: ${str(detail.llmSummary)}`);
  if (str(detail.finish)) lines.push(`Finished: ${str(detail.finish)}`);
  if (str(detail.result)) lines.push(`Result: ${str(detail.result)}`);

  const toolCalls = Array.isArray(detail.toolCalls) ? detail.toolCalls : [];
  for (const call of toolCalls) {
    const entry: Record<string, unknown> =
      typeof call === 'object' && call !== null && !Array.isArray(call) ? call : {};
    const tool = str(entry.tool) || 'tool';
    const flags = [
      entry.isError === true ? 'ERROR' : '',
      entry.free === true ? 'built-in' : '',
      typeof entry.staged === 'number' ? `staged ${entry.staged}` : '',
      typeof entry.durationMs === 'number' ? `${entry.durationMs}ms` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`- Tool call: ${tool}${flags ? ` (${flags})` : ''}`);
    if (str(entry.argsPreview)) lines.push(`  args: ${str(entry.argsPreview)}`);
    if (str(entry.resultPreview)) {
      // The stored preview is a 2 000-char display clip; the model read the
      // result whole up to TOOL_RESULT_CHARS. Say which where the preview ends.
      const preview = str(entry.resultPreview);
      const total = typeof entry.resultChars === 'number' ? entry.resultChars : null;
      const shown =
        total !== null && total > preview.length
          ? ` (preview of ${total.toLocaleString('en-US')} chars; ${
              total > TOOL_RESULT_CHARS
                ? `the model read the first ${TOOL_RESULT_CHARS.toLocaleString('en-US')}`
                : 'the model read all of it'
            })`
          : '';
      lines.push(`  result${shown}: ${preview.replace(/\n/g, '\n  ')}`);
    }
  }
  lines.push('');
  return lines;
}

export function renderRunDebugMarkdown(agentName: string, run: RunDetail): string {
  const seen = new SeenValues();
  const lines: string[] = [
    `# Agent run debug: ${agentName}`,
    '',
    `- Run id: ${run.id}`,
    `- Status: ${statusLabel(run.status)}`,
    `- Trigger: ${run.triggerKind}`,
    `- Created: ${run.createdAt}`,
    ...(run.finishedAt ? [`- Finished: ${run.finishedAt}`] : []),
    ...(run.durationMs !== null ? [`- Wall time: ${run.durationMs}ms`] : []),
    `- Active time: ${run.activeMs}ms (time waiting on a person excluded)`,
    ...(run.errorKind ? [`- Error kind: ${run.errorKind}`] : []),
    ...(run.error ? [`- Error: ${run.error}`] : []),
    ...(run.resumeCount > 0
      ? [
          `- Resumed by the owner: ${run.resumeCount} time(s)` +
            (run.resumedAt ? `, last ${run.resumedAt}` : ''),
          ...(run.resumeGuidance ? [`- Resume guidance: ${run.resumeGuidance}`] : []),
        ]
      : []),
    '',
    ...initialStateLines(run, seen),
    ...activityLines(run),
    ...definitionLines(run),
    ...batchLines(run),
    '## Turns',
    '',
  ];
  for (const attempt of run.attempts) lines.push(...turnLines(attempt, seen));
  if (run.attempts.length === 0) lines.push('(the run has not reached the model)');
  return lines.join('\n').trimEnd() + '\n';
}
