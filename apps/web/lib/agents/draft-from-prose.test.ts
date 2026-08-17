/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The drafting retry loop's contract: a bad reply goes back to the model
 * WITH the concrete problems (zod-diagnosed, quotable), one corrective
 * round trip is allowed, and a usable-but-imperfect first draft survives
 * a corrective attempt that regresses.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { LlmRequest } from '@renkei/agent-llm';

let replies: string[] = [];
const requests: LlmRequest[] = [];
jest.mock('@renkei/agent-llm', () => ({
  resolveAgentLlm: jest.fn(async () => ({
    ok: true,
    val: {
      provider: {
        complete: async (request: LlmRequest) => {
          requests.push(request);
          return {
            ok: true,
            val: {
              content: [{ type: 'text', text: replies[requests.length - 1] ?? '{}' }],
              stopReason: 'end_turn',
              usage: { inputTokens: 10, outputTokens: 10 },
            },
          };
        },
      },
      maxOutputTokens: 512,
    },
  })),
}));

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { draftAgentFromProse } from './draft-from-prose';

const db = {} as Kysely<DB>;
const TOOLS: ToolDescriptor[] = [
  {
    name: 'jira_search_issues',
    connector: 'jira',
    kind: 'read',
    title: 'Jira · Read — Search',
    description: 'search',
    appOnly: false,
    outcomes: {
      success: { label: 'ok' },
      failures: [{ code: 'not-found', label: 'Nothing matched', description: '', retriable: true }],
    },
  } as unknown as ToolDescriptor,
];

const GOOD_REPLY = JSON.stringify({
  name: 'Find tickets',
  steps: [
    {
      name: 'Search',
      instruction: 'Search with {{tool:jira_search_issues}}',
      tool: 'jira_search_issues',
      saveAs: 'the search',
    },
  ],
});

beforeEach(() => {
  replies = [];
  requests.length = 0;
});

describe('draftAgentFromProse retry loop', () => {
  it('feeds concrete zod problems back and succeeds on the corrected reply', async () => {
    replies = [
      JSON.stringify({ name: 'x', steps: [{ name: 'Broken' }] }), // no instruction
      GOOD_REPLY,
    ];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].tool).toBe('jira_search_issues');

    // The second call carried the diagnosis, not a shrug.
    expect(requests).toHaveLength(2);
    const feedback = JSON.stringify(requests[1].messages);
    expect(feedback).toContain('could not be used');
    expect(feedback).toContain('instruction');
  });

  it('retries an invented tool chip with the tool named in the feedback', async () => {
    replies = [
      JSON.stringify({
        name: 'x',
        steps: [
          { name: 'S', instruction: 'Use {{tool:jira_make_ticket}}', tool: 'jira_make_ticket' },
        ],
      }),
      GOOD_REPLY,
    ];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    expect(result.steps[0].tool).toBe('jira_search_issues');
    expect(JSON.stringify(requests[1].messages)).toContain('jira_make_ticket');
  });

  it('keeps a usable-but-imperfect first draft when the correction regresses', async () => {
    const softDraft = JSON.stringify({
      name: 'x',
      steps: [
        { name: 'S', instruction: 'Use {{tool:invented_tool}} to act', tool: 'invented_tool' },
      ],
    });
    replies = [softDraft, 'complete garbage, no json'];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    // The invented chip degraded to text; the step survived as tool-less.
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].tool).toBeNull();
  });

  it('parses model-authored failure handling, tries, and retry guidance', async () => {
    replies = [
      JSON.stringify({
        name: 'Find tickets',
        steps: [
          {
            name: 'Search',
            instruction: 'Search with {{tool:jira_search_issues}}',
            tool: 'jira_search_issues',
            saveAs: 'the search',
            tries: 4,
            failures: [
              {
                outcome: 'not-found',
                action: 'retry',
                guidance: 'Search again with {{tool:jira_search_issues}} and broader keywords.',
              },
              { outcome: 'other', action: 'stop' },
            ],
          },
        ],
      }),
    ];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const step = result.steps[0];
    expect(step.maxAttempts).toBe(4);
    expect(step.failureHandling).toHaveLength(2);
    expect(step.failureHandling[0]).toMatchObject({ outcome: 'not-found', action: 'retry' });
    // The guidance parsed into segments with its corrective tool chip intact.
    expect(step.failureHandling[0].guidance).toEqual(
      expect.arrayContaining([{ t: 'tool', name: 'jira_search_issues' }])
    );
    expect(step.failureHandling[1]).toMatchObject({ outcome: 'other', action: 'exit' });
    // No soft problems → no corrective round trip spent.
    expect(requests).toHaveLength(1);
  });

  it('feeds an invalid failure code back with the valid codes listed', async () => {
    replies = [
      JSON.stringify({
        name: 'x',
        steps: [
          {
            name: 'Search',
            instruction: 'Search with {{tool:jira_search_issues}}',
            tool: 'jira_search_issues',
            failures: [{ outcome: 'no-such-code', action: 'stop' }],
          },
        ],
      }),
      GOOD_REPLY,
    ];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const feedback = JSON.stringify(requests[1].messages);
    expect(feedback).toContain('no-such-code');
    expect(feedback).toContain('not-found');
  });

  it('returns the concrete reason when both attempts are unusable', async () => {
    replies = ['no json here', 'still no json'];
    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    expect('error' in result && result.error).toContain('no JSON object');
  });
});
