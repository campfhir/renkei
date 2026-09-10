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
    resumeCount: 0,
    resumedAt: null,
    resumeGuidance: null,
    resumeStepName: null,
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
          promptText:
            'Step: Create the ticket\n\nInstruction: Create it for ENG-808.\n\nTool budget: at most 3 tool call(s) this attempt.',
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

  it('reproduces the sent prompt byte-for-byte, before the appended context', () => {
    const text = renderRunDebugMarkdown('Read Webex Messages', fixtureRun());
    // The 1:1 contract: the fenced block IS the engine's captured message,
    // runtime values included; outcomes/summaries/tool calls follow it.
    expect(text).toContain(
      'User message (verbatim, as sent to the model):\n```text\n' +
        'Step: Create the ticket\n\nInstruction: Create it for ENG-808.\n\n' +
        'Tool budget: at most 3 tool call(s) this attempt.\n```'
    );
    expect(text.indexOf('User message (verbatim')).toBeLessThan(
      text.indexOf('Summary: The create call was rejected.')
    );
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

describe('renderRunDebugMarkdown — resumes and repeated values', () => {
  const PLAN_STEP = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';
  const USE_STEP = '2c3d4e5f-6071-4829-93a4-b5c6d7e8f901';
  // Longer than the elision threshold, and distinctive.
  const plan = `PLANNED UPDATES: ${'lorem ipsum dolor sit amet '.repeat(20)}END`;

  function resumedRun(): RunDetail {
    return {
      ...fixtureRun(),
      status: 'succeeded',
      errorKind: null,
      error: null,
      failedStepName: null,
      resumeCount: 1,
      resumedAt: '2026-09-09T16:00:00.000Z',
      resumeGuidance: 'The CIO project has no Task type — file it as a Project.',
      resumeStepName: 'Use the plan',
      stepsSnapshot: {
        version: 1,
        steps: [
          {
            id: PLAN_STEP,
            name: 'Make the plan',
            instruction: [{ t: 'text', v: 'Plan.' }],
            tool: null,
            maxAttempts: 1,
            saveAs: 'planned updates',
            failureHandling: [],
          },
          {
            id: USE_STEP,
            name: 'Use the plan',
            instruction: [
              { t: 'text', v: 'Apply ' },
              { t: 'var', name: 'planned updates' },
            ],
            tool: 'jira_create_issue',
            maxAttempts: 1,
            failureHandling: [],
          },
        ],
      },
      attempts: [
        {
          stepId: PLAN_STEP,
          stepIndex: 0,
          attempt: 1,
          iteration: 0,
          status: 'succeeded',
          outcome: 'llm_declared',
          outcomeCode: null,
          toolCallCount: 0,
          startedAt: null,
          finishedAt: null,
          detail: { promptText: 'Step: Make the plan', saveValue: plan },
          redacted: false,
        },
        {
          stepId: USE_STEP,
          stepIndex: 1,
          attempt: 1,
          iteration: 0,
          status: 'retired',
          outcome: 'tool_error',
          outcomeCode: 'invalid-input',
          toolCallCount: 1,
          startedAt: null,
          finishedAt: null,
          detail: {
            promptText: `Step: Use the plan\n\nKnown information:\n- planned updates: ${plan}`,
            llmSummary: 'Jira API 400: issuetype: Specify a valid issue type',
          },
          redacted: false,
        },
        {
          stepId: USE_STEP,
          stepIndex: 1,
          attempt: 2,
          iteration: 0,
          status: 'succeeded',
          outcome: 'tool_ok',
          outcomeCode: null,
          toolCallCount: 1,
          startedAt: null,
          finishedAt: null,
          detail: {
            promptText: `Step: Use the plan\n\nKnown information:\n- planned updates: ${plan}\n\nThe owner resumed this automation at this step after it failed.`,
            llmSummary: 'Created CIO-43.',
          },
          redacted: false,
        },
      ],
    };
  }

  it('says the run was resumed, where, and with what guidance', () => {
    const text = renderRunDebugMarkdown('Portfolio Updater', resumedRun());
    expect(text).toContain(
      '- Resumed by the owner: 1 time(s), last 2026-09-09T16:00:00.000Z at "Use the plan"'
    );
    expect(text).toContain(
      '- Resume guidance: The CIO project has no Task type — file it as a Project.'
    );
    expect(text).toContain(
      "Attempt 1: Set aside (Something about the request wasn't accepted) — 1 tool call(s)"
    );
    expect(text).toContain(
      'Set aside by the owner’s resume — the retry is the attempt after this one.'
    );
  });

  it('prints a long saved value once and points later prompts back at it', () => {
    const text = renderRunDebugMarkdown('Portfolio Updater', resumedRun());
    // Once, on the "Saved result" line of the step that saved it…
    expect(text.split(plan)).toHaveLength(2);
    expect(text).toContain(`Saved result: ${plan}`);
    // …and a pointer in every later prompt that carried it verbatim.
    const pointer = `[value of "planned updates", saved by "Make the plan" — ${plan.length} chars, shown above]`;
    expect(text.split(pointer)).toHaveLength(3);
    expect(text).toContain(`- planned updates: ${pointer}`);
    // The elided prompts say they were elided; an untouched one keeps its 1:1 label.
    expect(text).toContain('User message (as sent to the model, except that long values');
    expect(text).toContain(
      'User message (verbatim, as sent to the model):\n```text\nStep: Make the plan'
    );
  });

  it('leaves short values alone — they read better inline than as a pointer', () => {
    const run = resumedRun();
    const short = 'CIO-2, CIO-5';
    run.attempts[0].detail = { promptText: 'Step: Make the plan', saveValue: short };
    run.attempts[2].detail = {
      promptText: `Step: Use the plan\n\nKnown information:\n- planned updates: ${short}`,
    };
    const text = renderRunDebugMarkdown('Portfolio Updater', run);
    expect(text).toContain(`- planned updates: ${short}`);
    expect(text).not.toContain('shown above]');
  });
});
