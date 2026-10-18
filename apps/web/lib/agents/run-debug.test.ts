/**
 * The debug-copy renderer: what lands on the clipboard must carry the whole
 * story (error, instructions, turns, reads, staged changes and their
 * outcomes) and must NOT resurrect content the projection redacted.
 */

import { renderRunDebugMarkdown } from './run-debug';
import type { RunDetail } from './runs-view';

function fixtureRun(): RunDetail {
  return {
    id: 'run-1',
    status: 'failed',
    triggerKind: 'event',
    errorKind: 'agent_failed',
    error: 'Could not file the request: the project rejected it.',
    createdAt: '2026-08-21T10:54:00.000Z',
    startedAt: '2026-08-21T10:54:01.000Z',
    finishedAt: '2026-08-21T10:54:20.000Z',
    durationMs: 19_000,
    activeMs: 7_500,
    initialState: { subject: 'Laptop will not boot', from: 'ada@example.com' },
    initialStateRedacted: false,
    resumeCount: 0,
    resumedAt: null,
    resumeGuidance: null,
    definition: {
      instructions: '## Goal\n\nFile every hardware request.',
      tools: ['jsm_search_requests', 'jsm_create_request'],
    },
    attempts: [
      {
        stepId: 'turn',
        stepIndex: 1,
        attempt: 1,
        iteration: 0,
        status: 'succeeded',
        outcome: null,
        outcomeCode: null,
        toolCallCount: 3,
        startedAt: '2026-08-21T10:54:01.000Z',
        finishedAt: '2026-08-21T10:54:10.000Z',
        detail: {
          opening: 'An event you watch for just happened. Laptop will not boot',
          llmSummary: 'No existing request; filing one.',
          toolCalls: [
            {
              tool: 'jsm_search_requests',
              argsPreview: '{"query":"laptop"}',
              resultPreview: 'No requests found.',
              isError: false,
              durationMs: 120,
            },
            {
              tool: 'stage_actions',
              argsPreview: '{}',
              resultPreview: 'Accepted automatically.',
              isError: false,
              durationMs: 0,
              staged: 2,
            },
          ],
        },
        redacted: false,
      },
      {
        stepId: 'turn',
        stepIndex: 2,
        attempt: 2,
        iteration: 0,
        status: 'succeeded',
        outcome: 'failed',
        outcomeCode: null,
        toolCallCount: 0,
        startedAt: '2026-08-21T10:54:15.000Z',
        finishedAt: '2026-08-21T10:54:20.000Z',
        detail: { llmSummary: 'Could not file the request.', finish: 'failed' },
        redacted: false,
      },
    ],
    batches: [
      {
        id: 'batch-1',
        turn: 1,
        status: 'completed',
        reviewReason: null,
        acceptedBy: 'auto',
        createdAt: '2026-08-21T10:54:10.000Z',
        finishedAt: '2026-08-21T10:54:14.000Z',
        actionCount: 2,
        summary: 'File the request and tell Ada.',
        comment: null,
        actions: [
          { tool: 'jsm_create_request', args: { summary: 'Laptop will not boot' }, reason: 'New' },
          { tool: 'webex_send_message', args: { text: 'Filed' }, reason: 'Tell Ada' },
        ],
        results: [
          {
            tool: 'jsm_create_request',
            outcome: 'failed',
            text: 'Project HW is closed.',
            durationMs: 300,
          },
          { tool: 'webex_send_message', outcome: 'skipped', text: 'Not made.', durationMs: 0 },
        ],
      },
    ],
  };
}

describe('renderRunDebugMarkdown', () => {
  it('carries the error, the instructions, every turn and the staged outcomes', () => {
    const markdown = renderRunDebugMarkdown('Hardware intake', fixtureRun());
    expect(markdown).toContain('# Agent run debug: Hardware intake');
    expect(markdown).toContain('- Error: Could not file the request');
    expect(markdown).toContain('- Active time: 7500ms');
    expect(markdown).toContain('File every hardware request.');
    expect(markdown).toContain('### Turn 1');
    expect(markdown).toContain('Model said: No existing request; filing one.');
    expect(markdown).toContain('- Tool call: stage_actions (staged 2, 0ms)');
    expect(markdown).toContain('### Turn 2');
    expect(markdown).toContain('Finished: failed');
    expect(markdown).toContain('1. jsm_create_request — failed — New');
    expect(markdown).toContain('result: Project HW is closed.');
    // The activity list separates what it read from what it changed.
    expect(markdown).toContain('read jsm_search_requests — turn 1');
    expect(markdown).toContain('CHANGE jsm_create_request — FAILED — turn 1');
    expect(markdown).toContain('CHANGE webex_send_message — not made — turn 1');
  });

  it('elides a long trigger value repeated inside the opening message', () => {
    const run = fixtureRun();
    const body = 'x'.repeat(400);
    run.initialState = { body };
    run.attempts[0]!.detail = { opening: `Run input: ${body}` };
    const markdown = renderRunDebugMarkdown('Hardware intake', run);
    expect(markdown.split(body).length - 1).toBe(1);
    expect(markdown).toContain('[trigger.body — 400 chars, shown above]');
  });

  it('never resurrects redacted content', () => {
    const run = fixtureRun();
    run.initialStateRedacted = true;
    delete run.initialState;
    run.attempts = run.attempts.map((attempt) => {
      const { detail: _detail, ...rest } = attempt;
      return { ...rest, redacted: true };
    });
    run.batches = run.batches.map(
      ({ summary: _s, actions: _a, results: _r, comment: _c, ...rest }) => rest
    );
    const markdown = renderRunDebugMarkdown('Hardware intake', run);
    expect(markdown).not.toContain('Laptop will not boot');
    expect(markdown).not.toContain('Project HW is closed');
    expect(markdown).toContain('(details hidden for this audience)');
    expect(markdown).toContain('(2 action(s), hidden for this audience)');
  });
});
