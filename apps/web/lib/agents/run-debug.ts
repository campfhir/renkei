/**
 * A run rendered as paste-ready markdown — what the "Copy for debugging"
 * button on the run pages puts on the clipboard, written for handing to
 * Claude Code or another dev tool with zero cleanup.
 *
 * Works from the same RunDetail projection the page renders, so the
 * audience's redaction carries over untouched: an attempt the projection
 * withheld content for is copied as hidden, not resurrected here.
 */

import {
  describeFailureHandling,
  findNodeById,
  instructionPreview,
  isAgentStepsDoc,
  walkSteps,
} from '@renkei/agents';
import { statusLabel, outcomeCodeLabel } from '@/lib/agents/run-labels';
import { activityHeadline, runActivity } from '@/lib/agents/run-actions';
import type { AttemptView, RunDetail } from '@/lib/agents/runs-view';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stepNameOf(run: RunDetail, stepId: string, stepIndex: number): string {
  if (isAgentStepsDoc(run.stepsSnapshot)) {
    const found = findNodeById(run.stepsSnapshot.steps, stepId);
    if (found?.node.name) {
      switch (found.node.kind) {
        case 'branch':
          return `Branch: ${found.node.name}`;
        case 'loop':
          return `Loop: ${found.node.name}`;
        case 'group':
          return `Group: ${found.node.name}`;
        case 'terminal':
          return `End: ${found.node.name}`;
        case 'action':
        case undefined:
          return found.node.name;
        default: {
          const unhandled: never = found.node;
          throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
        }
      }
    }
  }
  return `Step ${stepIndex + 1}`;
}

/**
 * What the trigger handed the run.
 *
 * First section after the header on purpose: when an agent misbehaves, the
 * answer is very often that it was given something other than what the
 * author pictured — a space NAME where a step wanted a room id, an empty
 * subject, a body that arrived truncated. Reading the steps without this is
 * reading half the problem.
 */
function initialStateLines(run: RunDetail): string[] {
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
    // Multi-line values (an email body) are indented so the markdown stays
    // one list rather than collapsing into the surrounding prose.
    lines.push(`- ${key}: ${String(rendered ?? '').replace(/\n/g, '\n    ')}`);
  }
  lines.push('');
  return lines;
}

/** Every tool call in order — the "what did it touch" half of the paste. */
function activityLines(run: RunDetail): string[] {
  const activity = runActivity(run, (stepId, stepIndex) => stepNameOf(run, stepId, stepIndex));
  const lines = ['## What it did', '', activityHeadline(activity), ''];
  if (activity.toolsUsed.length > 0) {
    lines.push(`Tools used: ${activity.toolsUsed.join(', ')}`, '');
  }
  for (const action of activity.actions) {
    const where =
      `${action.stepName}` + (action.iteration > 0 ? ` (iteration ${action.iteration})` : '');
    lines.push(
      `${action.ordinal}. ${action.tool}${action.failed ? ' — FAILED' : ''} — in ${where}` +
        (action.durationMs !== null ? ` (${action.durationMs}ms)` : '')
    );
    if (action.argsPreview) lines.push(`   args: ${action.argsPreview}`);
  }
  if (activity.hiddenAttempts > 0) {
    lines.push(`(${activity.hiddenAttempts} attempt(s) had their calls hidden for this audience)`);
  }
  lines.push('');
  return lines;
}

/** The drafted steps as an outline — the "agent context" half of the paste. */
function snapshotLines(run: RunDetail): string[] {
  if (!isAgentStepsDoc(run.stepsSnapshot)) return [];
  const lines: string[] = ['## Agent steps (as snapshotted for this run)', ''];
  for (const { node, ordinal, depth } of walkSteps(run.stepsSnapshot.steps)) {
    const indent = '  '.repeat(depth - 1);
    switch (node.kind) {
      case 'branch':
        lines.push(
          `${indent}${ordinal + 1}. Branch: ${node.name} — condition: ` +
            instructionPreview(node.condition)
        );
        break;
      case 'loop':
        lines.push(
          node.mode === 'foreach'
            ? `${indent}${ordinal + 1}. Loop: ${node.name} — for each ${node.itemVar} in ${node.itemsVar} (max ${node.maxIterations})`
            : `${indent}${ordinal + 1}. Loop: ${node.name} — until: ${instructionPreview(node.condition)} (max ${node.maxIterations})`
        );
        if (node.collectVar) {
          lines.push(`${indent}   collects "${node.collectFrom}" into: ${node.collectVar}`);
        }
        break;
      case 'group':
        lines.push(`${indent}${ordinal + 1}. Group: ${node.name}`);
        break;
      case 'terminal': {
        const wording =
          node.result === 'failure'
            ? 'fails the run'
            : node.result === 'stop'
              ? 'stops the run (skipped)'
              : 'finishes the run';
        lines.push(`${indent}${ordinal + 1}. End: ${node.name} — ${wording}`);
        const message = instructionPreview(node.message);
        if (message) lines.push(`${indent}   message: ${message}`);
        break;
      }
      case 'action':
      case undefined: {
        lines.push(`${indent}${ordinal + 1}. ${node.name}`);
        const instruction = instructionPreview(node.instruction);
        if (instruction) lines.push(`${indent}   instruction: ${instruction}`);
        if (node.saveAs) lines.push(`${indent}   saves result as: ${node.saveAs}`);
        // The handling is part of what the run DID — a debug reader asking
        // "why did the run keep going after this failed?" finds the answer
        // here instead of in the builder.
        for (const handling of node.failureHandling) {
          lines.push(
            `${indent}   ${describeFailureHandling(handling, node.maxAttempts, node.saveAs)}`
          );
        }
        if (node.needsApproval) {
          lines.push(
            `${indent}   needs approval: pauses for the owner before this tool call, waits up to ${node.approvalTimeoutHours ?? 96}h` +
              (node.onNotApproved
                ? `; if not approved, path: ${node.onNotApproved.name}`
                : '; if not approved, continues below')
          );
        }
        break;
      }
      default: {
        const unhandled: never = node;
        throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  lines.push('');
  return lines;
}

function attemptLines(attempt: AttemptView): string[] {
  const heading =
    `- ${attempt.iteration > 0 ? `Iteration ${attempt.iteration}, attempt` : 'Attempt'} ${attempt.attempt}: ${statusLabel(attempt.status)}` +
    (attempt.outcomeCode ? ` (${outcomeCodeLabel(attempt.outcomeCode)})` : '') +
    (attempt.toolCallCount > 0 ? ` — ${attempt.toolCallCount} tool call(s)` : '');
  if (attempt.redacted) return [heading, '  (details hidden for this audience)'];

  const lines = [heading];
  const detail: Record<string, unknown> =
    typeof attempt.detail === 'object' && attempt.detail !== null && !Array.isArray(attempt.detail)
      ? attempt.detail
      : {};
  // The prompt the model was actually sent, byte-for-byte — captured by
  // the engine at send time (attempts recorded before that ship only the
  // resolved-instruction preview below). Everything after it — outcomes,
  // summaries, tool calls, errors — is appended context; this block is the
  // 1:1 part.
  if (str(detail.promptText)) {
    lines.push(
      '  Prompt (verbatim, as sent to the model):',
      '```text',
      str(detail.promptText),
      '```'
    );
  }
  if (str(detail.chosenPathName)) lines.push(`  Took path: ${str(detail.chosenPathName)}`);
  // A skip ends the WHOLE run from inside a "Succeeded" attempt — without
  // this line the debug paste shows a green attempt and then an
  // unexplained stop ('nothing-to-do' is the pre-rename stored spelling).
  const declared = str(detail.declaredOutcome);
  if (declared === 'skipped' || declared === 'nothing-to-do') {
    lines.push(
      '  Declared skipped — the step judged the automation does not apply; the run stopped here.'
    );
  }
  if (str(detail.llmSummary)) lines.push(`  Summary: ${str(detail.llmSummary)}`);
  if (str(detail.guidanceUsed)) lines.push(`  Guidance used: ${str(detail.guidanceUsed)}`);
  if (str(detail.saveValue)) lines.push(`  Saved result: ${str(detail.saveValue)}`);

  const toolCalls = Array.isArray(detail.toolCalls) ? detail.toolCalls : [];
  for (const call of toolCalls) {
    const entry: Record<string, unknown> =
      typeof call === 'object' && call !== null && !Array.isArray(call) ? call : {};
    const tool = str(entry.tool) || 'tool';
    const flags = [
      entry.isError === true ? 'ERROR' : '',
      typeof entry.durationMs === 'number' ? `${entry.durationMs}ms` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`  Tool call: ${tool}${flags ? ` (${flags})` : ''}`);
    if (str(entry.argsPreview)) lines.push(`    args: ${str(entry.argsPreview)}`);
    if (str(entry.resultPreview)) {
      lines.push(`    result: ${str(entry.resultPreview).replace(/\n/g, '\n    ')}`);
    }
  }
  return lines;
}

export function renderRunDebugMarkdown(agentName: string, run: RunDetail): string {
  const lines: string[] = [
    `# Agent run debug: ${agentName}`,
    '',
    `- Run id: ${run.id}`,
    `- Status: ${statusLabel(run.status)}`,
    `- Trigger: ${run.triggerKind}`,
    `- Created: ${run.createdAt}`,
    ...(run.finishedAt ? [`- Finished: ${run.finishedAt}`] : []),
    ...(run.durationMs !== null ? [`- Duration: ${run.durationMs}ms`] : []),
    ...(run.errorKind ? [`- Error kind: ${run.errorKind}`] : []),
    ...(run.failedStepName ? [`- Failed step: ${run.failedStepName}`] : []),
    ...(run.error ? [`- Error: ${run.error}`] : []),
    '',
    ...initialStateLines(run),
    ...activityLines(run),
    ...snapshotLines(run),
    '## Timeline',
    '',
  ];

  const byStep = new Map<string, AttemptView[]>();
  for (const attempt of run.attempts) {
    const list = byStep.get(attempt.stepId) ?? [];
    list.push(attempt);
    byStep.set(attempt.stepId, list);
  }
  for (const [stepId, attempts] of byStep) {
    lines.push(`### ${stepNameOf(run, stepId, attempts[0]?.stepIndex ?? 0)}`);
    for (const attempt of attempts) lines.push(...attemptLines(attempt));
    lines.push('');
  }
  if (run.attempts.length === 0) lines.push('(no steps ran)');

  return lines.join('\n').trimEnd() + '\n';
}
