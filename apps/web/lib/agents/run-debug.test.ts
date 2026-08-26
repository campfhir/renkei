/**
 * The debug-copy renderer: what lands on the clipboard must carry the whole
 * failure story (error, step outline, attempts, tool errors) and must NOT
 * resurrect content the projection redacted.
 */

import { renderRunDebugMarkdown } from './run-debug';
import type { RunDetail } from './runs-view';

const STEP_ID = '9c0f57d2-6c3e-4b5f-8f57-0a5e2b8d9101';

function fixtureRun(): RunDetail {
  return {
    id: 'run-1',
    status: 'failed',
    triggerKind: 'event',
    errorKind: 'step_failed',
    error: 'Step "Create ticket" failed after 2 attempts (invalid-input).',
    failedStepName: 'Create ticket',
    createdAt: '2026-08-21T10:54:00.000Z',
    startedAt: '2026-08-21T10:54:01.000Z',
    finishedAt: '2026-08-21T10:54:20.000Z',
    durationMs: 19_000,
    initialState: { 'trigger.subject': 'Laptop will not boot', 'trigger.from': 'ada@example.com' },
    initialStateRedacted: false,
    stepsSnapshot: {
      version: 1,
      steps: [
        {
          id: STEP_ID,
          name: 'Create ticket',
          instruction: [
            { t: 'text', v: 'File the request with ' },
            { t: 'tool', name: 'jsm_create_request' },
          ],
          tool: 'jsm_create_request',
          maxAttempts: 2,
          saveAs: 'ticket',
          failureHandling: [],
        },
      ],
    },
    attempts: [
      {
        stepId: STEP_ID,
        stepIndex: 0,
        attempt: 1,
        iteration: 0,
        status: 'failed',
        outcome: 'tool_error',
        outcomeCode: 'invalid-input',
        toolCallCount: 1,
        startedAt: '2026-08-21T10:54:01.000Z',
        finishedAt: '2026-08-21T10:54:10.000Z',
        detail: {
          llmSummary: 'The create call was rejected.',
          toolCalls: [
            {
              tool: 'jsm_create_request',
              isError: true,
              durationMs: 278,
              argsPreview: '{"serviceDeskId":"CAS"}',
              resultPreview: 'Jira API 400: This request is invalid.',
            },
          ],
        },
        redacted: false,
      },
      {
        stepId: STEP_ID,
        stepIndex: 0,
        attempt: 2,
        iteration: 0,
        status: 'failed',
        outcome: 'tool_error',
        outcomeCode: 'invalid-input',
        toolCallCount: 1,
        startedAt: '2026-08-21T10:54:11.000Z',
        finishedAt: '2026-08-21T10:54:20.000Z',
        redacted: true,
      },
    ],
  };
}

describe('renderRunDebugMarkdown', () => {
  it('carries the failure story end to end', () => {
    const text = renderRunDebugMarkdown('Read Webex Messages', fixtureRun());

    expect(text).toContain('# Agent run debug: Read Webex Messages');
    expect(text).toContain('Step "Create ticket" failed after 2 attempts');
    expect(text).toContain('- Failed step: Create ticket');
    // The drafted step outline, chips rendered readably.
    expect(text).toContain('1. Create ticket');
    expect(text).toContain('File the request with [jsm_create_request]');
    expect(text).toContain('saves result as: ticket');
    // The attempt trail with the tool error.
    expect(text).toContain('Attempt 1');
    expect(text).toContain('Tool call: jsm_create_request (ERROR, 278ms)');
    expect(text).toContain('Jira API 400');
  });

  it('keeps redacted attempts redacted', () => {
    const text = renderRunDebugMarkdown('Read Webex Messages', fixtureRun());
    expect(text).toContain('(details hidden for this audience)');
  });
});

describe('the troubleshooting sections', () => {
  it('leads with what the trigger handed the run', () => {
    // The most common cause of "the agent did the wrong thing" is that it was
    // given something other than the author pictured, so this comes first.
    const text = renderRunDebugMarkdown('Read Webex Messages', fixtureRun());

    expect(text).toContain('## Trigger input');
    expect(text).toContain('trigger.subject: Laptop will not boot');
    expect(text.indexOf('## Trigger input')).toBeLessThan(text.indexOf('## Timeline'));
  });

  it('says the trigger input is hidden rather than omitting the section', () => {
    // An admin on a succeeded run. Silence would read as "the trigger passed
    // nothing", which is a different and wrong answer.
    const run = fixtureRun();
    delete run.initialState;
    run.initialStateRedacted = true;

    const text = renderRunDebugMarkdown('Read Webex Messages', run);

    expect(text).toContain('## Trigger input');
    expect(text).toContain('(hidden for this audience)');
  });

  it('lists every tool call in execution order with its step', () => {
    const text = renderRunDebugMarkdown('Read Webex Messages', fixtureRun());

    expect(text).toContain('## What it did');
    expect(text).toContain('1. jsm_create_request — FAILED — in Create ticket');
    expect(text).toContain('args: {"serviceDeskId":"CAS"}');
  });

  it('counts a redacted attempt without listing its calls', () => {
    // The fixture's second attempt is redacted and had one call. The COUNT is
    // content-free and belongs in the headline; the call itself does not.
    const text = renderRunDebugMarkdown('Read Webex Messages', fixtureRun());

    expect(text).toContain('2 tool calls');
    expect(text).toContain('1 attempt(s) had their calls hidden');
    // Only the visible call is enumerated.
    expect(text).not.toContain('2. jsm_create_request');
  });

  it('says so plainly when nothing was called', () => {
    const run = fixtureRun();
    run.attempts = [];

    expect(renderRunDebugMarkdown('Quiet agent', run)).toContain('No tools were called.');
  });
});
