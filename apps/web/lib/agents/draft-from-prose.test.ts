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

// The org's step ceiling; null = settings unavailable (the fallback path).
let orgMaxSteps: number | null = null;
jest.mock('@renkei/settings', () => ({
  getOrgSettings: jest.fn(async () =>
    orgMaxSteps === null ? { ok: false } : { ok: true, val: { agentMaxSteps: orgMaxSteps } }
  ),
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
import {
  isBranchStep,
  type ActionStep,
  type AgentStepNode,
  type ApprovalStep,
  type BranchStep,
  type LoopStep,
} from '@renkei/agents';
import { draftAgentFromProse } from './draft-from-prose';

/** Narrow a drafted node to an action step — containers fail the test loudly. */
function actionOf(node: AgentStepNode | undefined): ActionStep {
  if (!node || (node.kind !== undefined && node.kind !== 'action')) {
    throw new Error('expected an action step');
  }
  return node;
}

function branchOf(node: AgentStepNode | undefined): BranchStep {
  if (!node || !isBranchStep(node)) throw new Error('expected a branch');
  return node;
}

function loopOf(node: AgentStepNode | undefined): LoopStep {
  if (!node || node.kind !== 'loop') throw new Error('expected a loop');
  return node;
}

function askOf(node: AgentStepNode | undefined): ApprovalStep {
  if (!node || node.kind !== 'approval') throw new Error('expected an ask');
  return node;
}

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
  orgMaxSteps = null;
});

/**
 * The step ceiling is the ORG'S setting, end to end: the prompt offers it
 * and the reply envelope accepts it. A hardcoded 20 in either place meant
 * an agent the raised limit let grow past 20 steps could never be revised
 * through drafting again.
 */
describe('the org step ceiling reaches the drafting contract', () => {
  it('prompts and parses with the org limit, not a hardcoded 20', async () => {
    orgMaxSteps = 40;
    const steps = Array.from({ length: 25 }, (_, index) => ({
      name: `Step ${index + 1}`,
      instruction: `Search round ${index + 1} with {{tool:jira_search_issues}}`,
      tool: 'jira_search_issues',
    }));
    replies = [JSON.stringify({ name: 'Big agent', steps })];

    const result = await draftAgentFromProse(db, 't1', 'do many things', TOOLS);
    if ('error' in result) throw new Error(result.error);
    expect(result.steps).toHaveLength(25);
    expect(JSON.stringify(requests[0].messages)).toContain('array of 1 to 40 objects');
  });

  it('falls back to the platform default when settings are unavailable', async () => {
    replies = [GOOD_REPLY];
    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    expect(JSON.stringify(requests[0].messages)).toContain('array of 1 to 20 objects');
  });
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
    expect(actionOf(result.steps[0]).tool).toBe('jira_search_issues');

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
    expect(actionOf(result.steps[0]).tool).toBe('jira_search_issues');
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
    expect(actionOf(result.steps[0]).tool).toBeNull();
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
    const step = actionOf(result.steps[0]);
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

  it('keeps a custom condition when a "when" description defines it', async () => {
    replies = [
      JSON.stringify({
        name: 'x',
        steps: [
          {
            name: 'Search',
            instruction: 'Search with {{tool:jira_search_issues}}',
            tool: 'jira_search_issues',
            failures: [
              {
                outcome: 'Poor Match!',
                action: 'retry',
                when: 'results exist but none match the description closely enough',
                guidance: 'Reword the search using the description itself.',
              },
              {
                outcome: 'not-found',
                action: 'continue',
                guidance: 'That is a valid answer — note it and move on.',
              },
            ],
          },
        ],
      }),
    ];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const step = actionOf(result.steps[0]);
    // The invented code is re-slugged the way the builder would write it.
    expect(step.failureHandling[0]).toMatchObject({
      outcome: 'poor-match',
      action: 'retry',
      when: 'results exist but none match the description closely enough',
    });
    // Non-retry prose survives as the advisory note.
    expect(step.failureHandling[1]).toMatchObject({ outcome: 'not-found', action: 'continue' });
    expect(step.failureHandling[1].guidance).toEqual(
      expect.arrayContaining([expect.objectContaining({ t: 'text' })])
    );
    // No soft problems → no corrective round trip spent.
    expect(requests).toHaveLength(1);
  });

  it('omits the guidance key entirely when non-retry guidance is empty', async () => {
    replies = [
      JSON.stringify({
        name: 'x',
        steps: [
          {
            name: 'Search',
            instruction: 'Search with {{tool:jira_search_issues}}',
            tool: 'jira_search_issues',
            failures: [{ outcome: 'not-found', action: 'continue', guidance: '   ' }],
          },
        ],
      }),
    ];
    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const step = actionOf(result.steps[0]);
    expect(step.failureHandling[0]).toEqual({ outcome: 'not-found', action: 'continue' });
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

  it('carries onSuccess through and renames duplicate result names', async () => {
    replies = [
      JSON.stringify({
        name: 'x',
        steps: [
          {
            name: 'Search',
            instruction: 'Search with {{tool:jira_search_issues}}',
            tool: 'jira_search_issues',
            saveAs: 'the result',
          },
          {
            name: 'Reply and stop',
            instruction: 'Reply and stop silently if nothing matched.',
            tool: null,
            saveAs: 'the result',
            onSuccess: 'stop-quiet',
          },
        ],
      }),
      // The duplicate name is a soft problem → one corrective round trip;
      // the second reply repeats it, and the parser's rename keeps the
      // draft usable anyway.
      JSON.stringify({
        name: 'x',
        steps: [
          {
            name: 'Search',
            instruction: 'Search with {{tool:jira_search_issues}}',
            tool: 'jira_search_issues',
            saveAs: 'the result',
          },
          {
            name: 'Reply and stop',
            instruction: 'Reply and stop silently if nothing matched.',
            tool: null,
            saveAs: 'the result',
            onSuccess: 'stop-quiet',
          },
        ],
      }),
    ];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    expect(actionOf(result.steps[1]).onSuccess).toBe('stop-quiet');
    expect(actionOf(result.steps[0]).saveAs).toBe('the result');
    expect(actionOf(result.steps[1]).saveAs).toBe('the result 2');
    // The feedback named the duplicate.
    expect(JSON.stringify(requests[1].messages)).toContain('reuses the result name');
  });

  it('drafts a two-way branch from the legacy ifSteps/elseSteps wire shape', async () => {
    replies = [
      JSON.stringify({
        name: 'Comment or create',
        steps: [
          {
            name: 'Search',
            instruction: 'Search with {{tool:jira_search_issues}}',
            tool: 'jira_search_issues',
            saveAs: 'the search',
          },
          {
            kind: 'branch',
            name: 'Was a ticket found?',
            condition: 'Did {{var:the search}} find a ticket?',
            ifLabel: 'A ticket exists',
            elseLabel: 'Otherwise',
            ifSteps: [{ name: 'Note it', instruction: 'Note the ticket key.', tool: null }],
            elseSteps: [],
          },
        ],
      }),
    ];

    const result = await draftAgentFromProse(db, 't1', 'comment or create a ticket', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const branch = branchOf(result.steps[1]);
    expect(branch.paths).toHaveLength(2);
    expect(branch.paths[0].name).toBe('A ticket exists');
    expect(branch.paths[1].name).toBe('Otherwise');
    expect(branch.paths[0].steps).toHaveLength(1);
    expect(branch.paths[1].steps).toHaveLength(0);
    expect(branch.condition).toEqual(expect.arrayContaining([{ t: 'var', name: 'the search' }]));
    // No soft problems → no corrective round trip spent.
    expect(requests).toHaveLength(1);
  });

  it('drafts an n-way branch from the paths array wire shape', async () => {
    replies = [
      JSON.stringify({
        name: 'Route it',
        steps: [
          {
            name: 'Search',
            instruction: 'Search with {{tool:jira_search_issues}}',
            tool: 'jira_search_issues',
            saveAs: 'the search',
          },
          {
            kind: 'branch',
            name: 'What kind of request?',
            condition: 'Judge {{var:the search}}: bug, question, or something else?',
            paths: [
              {
                label: 'A bug',
                steps: [{ name: 'Note bug', instruction: 'Note it.', tool: null }],
              },
              { label: 'A question', steps: [] },
              { label: 'Something else', steps: [] },
            ],
          },
        ],
      }),
    ];

    const result = await draftAgentFromProse(db, 't1', 'route requests by kind', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const branch = branchOf(result.steps[1]);
    expect(branch.paths.map((path) => path.name)).toEqual([
      'A bug',
      'A question',
      'Something else',
    ]);
    expect(branch.paths[0].steps).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it('drafts a for-each loop with a collected list and scoped item variable', async () => {
    replies = [
      JSON.stringify({
        name: 'Summarize tickets',
        steps: [
          {
            name: 'Search',
            instruction: 'Search with {{tool:jira_search_issues}}',
            tool: 'jira_search_issues',
            saveAs: 'the tickets',
          },
          {
            kind: 'loop',
            name: 'Summarize each',
            over: 'the tickets',
            itemName: 'ticket',
            maxIterations: 5,
            collectFrom: 'summary',
            collectVar: 'summaries',
            steps: [
              {
                name: 'Summarize',
                instruction: 'Summarize {{var:ticket}} briefly.',
                tool: null,
                saveAs: 'summary',
              },
            ],
          },
          {
            name: 'Report',
            instruction: 'Report using {{var:summaries}}.',
            tool: null,
          },
        ],
      }),
    ];

    const result = await draftAgentFromProse(db, 't1', 'summarize each ticket found', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const loop = loopOf(result.steps[1]);
    expect(loop.mode).toBe('foreach');
    if (loop.mode !== 'foreach') throw new Error('unreachable');
    expect(loop.itemsVar).toBe('the tickets');
    expect(loop.itemVar).toBe('ticket');
    expect(loop.maxIterations).toBe(5);
    expect(loop.collectFrom).toBe('summary');
    expect(loop.collectVar).toBe('summaries');
    // The {{var:ticket}} chip inside the body verified (scoped item name).
    expect(actionOf(loop.steps[0]).instruction).toEqual(
      expect.arrayContaining([{ t: 'var', name: 'ticket' }])
    );
    // ...and {{var:summaries}} verified for the step after the loop.
    expect(actionOf(result.steps[2]).instruction).toEqual(
      expect.arrayContaining([{ t: 'var', name: 'summaries' }])
    );
    expect(requests).toHaveLength(1);
  });

  it('drafts an until loop and drops a collect whose source is outside the body', async () => {
    const withBadCollect = JSON.stringify({
      name: 'Page it all',
      steps: [
        {
          kind: 'loop',
          name: 'Keep paging',
          until: 'The last search returned nothing new.',
          maxIterations: 10,
          collectFrom: 'not inside',
          collectVar: 'pages',
          steps: [
            {
              name: 'Page',
              instruction: 'Fetch the next page with {{tool:jira_search_issues}}.',
              tool: 'jira_search_issues',
              saveAs: 'the page',
            },
          ],
        },
      ],
    });
    replies = [withBadCollect, withBadCollect];

    const result = await draftAgentFromProse(db, 't1', 'page until done', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const loop = loopOf(result.steps[0]);
    expect(loop.mode).toBe('until');
    expect('collectVar' in loop).toBe(false);
    expect(JSON.stringify(requests[1].messages)).toContain('no step INSIDE the loop');
  });

  it('rejects a loop inside a loop with corrective feedback', async () => {
    const nested = JSON.stringify({
      name: 'x',
      steps: [
        {
          name: 'Search',
          instruction: 'Search with {{tool:jira_search_issues}}',
          tool: 'jira_search_issues',
          saveAs: 'the tickets',
        },
        {
          kind: 'loop',
          name: 'Outer',
          over: 'the tickets',
          itemName: 'ticket',
          steps: [
            {
              kind: 'loop',
              name: 'Inner',
              until: 'Done.',
              steps: [{ name: 'S', instruction: 'Do a thing.', tool: null }],
            },
            { name: 'Act', instruction: 'Act on {{var:ticket}}.', tool: null },
          ],
        },
      ],
    });
    replies = [nested, nested];

    const result = await draftAgentFromProse(db, 't1', 'loop the loops', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const loop = loopOf(result.steps[1]);
    // The inner loop was refused; the rest of the body survived.
    expect(loop.steps).toHaveLength(1);
    expect(JSON.stringify(requests[1].messages)).toContain('loops never nest');
  });

  it('drafts a named group whose steps run as if inlined', async () => {
    replies = [
      JSON.stringify({
        name: 'x',
        steps: [
          {
            kind: 'group',
            name: 'Triage',
            steps: [
              {
                name: 'Search',
                instruction: 'Search with {{tool:jira_search_issues}}',
                tool: 'jira_search_issues',
              },
            ],
          },
        ],
      }),
    ];

    const result = await draftAgentFromProse(db, 't1', 'the triage phase searches', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const group = result.steps[0];
    if (group?.kind !== 'group') throw new Error('expected a group');
    expect(group.name).toBe('Triage');
    expect(group.steps).toHaveLength(1);
  });

  it('drafts schedule and event triggers when asked, defaulting an unstated timezone to the user', async () => {
    replies = [
      JSON.stringify({
        name: 'Morning triage',
        steps: [
          {
            name: 'Search',
            instruction: 'Search with {{tool:jira_search_issues}}',
            tool: 'jira_search_issues',
          },
        ],
        triggers: [
          { kind: 'schedule', rules: [{ every: 'weekday', at: '09:00' }], timezone: null },
          { kind: 'event', eventId: 'webex/message.received' },
        ],
      }),
    ];

    const result = await draftAgentFromProse(
      db,
      't1',
      'every weekday morning at 9, and when someone messages me, triage tickets',
      TOOLS,
      { suggestTriggers: true }
    );
    if ('error' in result) throw new Error(result.error);
    expect(result.triggers).toEqual([
      // Timezone '' = "the prose never named one" — the builder fills in
      // the user's own zone.
      { kind: 'schedule', recurrences: [{ every: 'weekday', at: '09:00' }], timezone: '' },
      { kind: 'event', eventId: 'webex/message.received' },
    ]);
    // The prompt carried the rules: the catalog, and the no-inventing rule.
    const prompt = JSON.stringify(requests[0].messages);
    expect(prompt).toContain('never invent or guess a trigger');
    expect(prompt).toContain('microsoft/mail.received');
    expect(requests).toHaveLength(1);
  });

  it('keeps a filter the prose stated, normalized', async () => {
    replies = [
      JSON.stringify({
        name: 'Billing watch',
        steps: [
          {
            name: 'Search',
            instruction: 'Search with {{tool:jira_search_issues}}',
            tool: 'jira_search_issues',
          },
        ],
        triggers: [
          {
            kind: 'event',
            eventId: 'microsoft/mail.received',
            match: { fromAddresses: ['Billing@ACME.example'], subjectContains: 'invoice' },
          },
        ],
      }),
    ];

    const result = await draftAgentFromProse(
      db,
      't1',
      'when an email from Billing@ACME.example about an invoice arrives, search jira',
      TOOLS,
      { suggestTriggers: true }
    );
    if ('error' in result) throw new Error(result.error);
    expect(result.triggers).toEqual([
      {
        kind: 'event',
        eventId: 'microsoft/mail.received',
        match: { fromAddresses: ['billing@acme.example'], subjectContains: 'invoice' },
      },
    ]);

    // The prompt has to offer the fields, and has to say not to invent one:
    // a filter nobody asked for stops the agent firing and says nothing.
    const prompt = JSON.stringify(requests[0].messages);
    expect(prompt).toContain('match.fromAddresses');
    expect(prompt).toContain('match.roomIds');
    expect(prompt).toContain('silently never run');
  });

  it('asks again about a malformed filter, then keeps the trigger without it', async () => {
    const badFilter = JSON.stringify({
      name: 'Billing watch',
      steps: [
        {
          name: 'Search',
          instruction: 'Search with {{tool:jira_search_issues}}',
          tool: 'jira_search_issues',
        },
      ],
      triggers: [
        {
          kind: 'event',
          eventId: 'microsoft/mail.received',
          match: { fromAddresses: ['not-an-address'] },
        },
      ],
    });
    // The same mistake every round, so the corrective loop runs out.
    replies = [badFilter, badFilter, badFilter];

    const result = await draftAgentFromProse(db, 't1', 'watch billing mail', TOOLS, {
      suggestTriggers: true,
    });
    if ('error' in result) throw new Error(result.error);

    // A bad filter is worth one correction — the model can usually fix an
    // address — but it is never fatal: the trigger and the steps survive
    // without it rather than the whole draft being refused.
    expect(result.triggers).toEqual([{ kind: 'event', eventId: 'microsoft/mail.received' }]);
    expect(requests.length).toBeGreaterThan(1);
    expect(JSON.stringify(requests[1].messages)).toContain('filter was dropped');
  });

  it('drops an invented event id and an unknown agent name with corrective feedback', async () => {
    const inventing = JSON.stringify({
      name: 'x',
      steps: [
        {
          name: 'Search',
          instruction: 'Search with {{tool:jira_search_issues}}',
          tool: 'jira_search_issues',
        },
      ],
      triggers: [
        { kind: 'event', eventId: 'slack/message.received' },
        { kind: 'agent', agentName: 'No Such Agent' },
      ],
    });
    replies = [inventing, inventing];

    const result = await draftAgentFromProse(
      db,
      't1',
      'when a slack message arrives, triage',
      TOOLS,
      {
        suggestTriggers: true,
        otherAgents: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Daily digest' }],
      }
    );
    if ('error' in result) throw new Error(result.error);
    // Both invented entries dropped; the steps still drafted.
    expect(result.triggers).toEqual([]);
    const feedback = JSON.stringify(requests[1].messages);
    expect(feedback).toContain('slack/message.received');
    expect(feedback).toContain('webex/message.received');
    expect(feedback).toContain('No Such Agent');
    expect(feedback).toContain('Daily digest');
  });

  it('matches an agent-finished trigger to an owned agent by name', async () => {
    replies = [
      JSON.stringify({
        name: 'x',
        steps: [{ name: 'Summarize', instruction: 'Summarize the parent run.', tool: null }],
        triggers: [{ kind: 'agent', agentName: 'daily digest' }],
      }),
    ];

    const result = await draftAgentFromProse(
      db,
      't1',
      'after my daily digest finishes, summarize',
      TOOLS,
      {
        suggestTriggers: true,
        otherAgents: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Daily Digest' }],
      }
    );
    if ('error' in result) throw new Error(result.error);
    expect(result.triggers).toEqual([
      { kind: 'agent', callerAgentId: '22222222-2222-4222-8222-222222222222' },
    ]);
  });

  it('ignores volunteered triggers when suggestions were not requested', async () => {
    replies = [
      JSON.stringify({
        name: 'x',
        steps: [{ name: 'S', instruction: 'Do a thing.', tool: null }],
        triggers: [{ kind: 'schedule', rules: [{ every: 'day', at: '08:00' }], timezone: null }],
      }),
    ];

    const result = await draftAgentFromProse(db, 't1', 'do a thing please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    expect('triggers' in result).toBe(false);
    // Without the offer, the prompt never mentions the trigger wire shape.
    expect(JSON.stringify(requests[0].messages)).not.toContain('never invent or guess a trigger');
  });

  it('returns an empty triggers array when the prose never says when it runs', async () => {
    replies = [GOOD_REPLY];
    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS, {
      suggestTriggers: true,
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.triggers).toEqual([]);
  });

  it('returns the concrete reason when both attempts are unusable', async () => {
    replies = ['no json here', 'still no json'];
    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    expect('error' in result && result.error).toContain('no JSON object');
  });

  it('sanitizes an illegal result name and feeds the rule back', async () => {
    const badName = JSON.stringify({
      name: 'x',
      steps: [
        {
          name: 'Search',
          instruction: 'Search with {{tool:jira_search_issues}}',
          tool: 'jira_search_issues',
          saveAs: '2nd result!!',
        },
      ],
    });
    replies = [badName, badName];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    // Stripped to pattern shape: leading non-letters and "!" gone.
    expect(actionOf(result.steps[0]).saveAs).toBe('nd result');
    expect(JSON.stringify(requests[1].messages)).toContain('not a usable name');
  });

  it('degrades an unprovided trigger.* chip to text and names the legal set', async () => {
    const inventedTrigger = JSON.stringify({
      name: 'x',
      steps: [
        {
          name: 'Reply',
          instruction: 'Reply in {{var:trigger.roomId}} politely.',
          tool: null,
        },
      ],
    });
    replies = [inventedTrigger, inventedTrigger];

    const result = await draftAgentFromProse(db, 't1', 'reply to webex messages', TOOLS, {
      triggerVars: [{ name: 'trigger.subject', description: 'The subject line.' }],
    });
    if ('error' in result) throw new Error(result.error);
    // The chip degraded to plain text, so the save can never bounce on it.
    expect(actionOf(result.steps[0]).instruction).toEqual(
      expect.arrayContaining([{ t: 'text', v: 'Reply in trigger.roomId politely.' }])
    );
    const feedback = JSON.stringify(requests[1].messages);
    expect(feedback).toContain('no attached trigger provides it');
    expect(feedback).toContain('trigger.subject');
  });

  it('renders trigger variable descriptions into the prompt', async () => {
    replies = [GOOD_REPLY];
    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS, {
      triggerVars: [
        { name: 'trigger.roomId', description: 'Pass it to webex_send_message to reply.' },
      ],
    });
    if ('error' in result) throw new Error(result.error);
    const prompt = JSON.stringify(requests[0].messages);
    expect(prompt).toContain('trigger.roomId: Pass it to webex_send_message to reply.');
  });

  it('renders each tool description in FULL — never clipped', async () => {
    // The drafting model never sees input schemas, so the description is
    // its only account of a tool's requirements. This used to clip at 100
    // characters, cutting most descriptions mid-sentence — the part that
    // taught a tool's inputs ("reporter, assignee, priority are their own
    // inputs here") was exactly what the model never read.
    const longTail =
      'Reporter, assignee, priority, and components are their own inputs here — pass them ' +
      'as fields, never as lines inside the description text.';
    const longTool: ToolDescriptor = {
      name: 'jsm_create_request',
      connector: 'jsm',
      kind: 'act',
      title: 'JSM · Act — Create a request',
      description:
        'Create a customer request in a service desk. Prefer this over jira_create_issue ' +
        'whenever the target project is a service desk — a plain issue in a service desk ' +
        `project skips its request types and SLAs. ${longTail}`,
      appOnly: false,
      outcomes: { success: { label: 'ok' }, failures: [] },
    };
    replies = [GOOD_REPLY];
    const result = await draftAgentFromProse(db, 't1', 'file tickets from messages', [
      ...TOOLS,
      longTool,
    ]);
    if ('error' in result) throw new Error(result.error);
    const prompt = JSON.stringify(requests[0].messages);
    expect(prompt).toContain(longTail);
  });
});

describe('gap-closing review loop (refineWithReview)', () => {
  const REVIEW_CONCERN = JSON.stringify({
    summary: 'It searches for tickets.',
    concerns: [
      { issue: 'Nothing tells the user what was found.', fix: 'Add a step that replies.' },
    ],
  });
  const REVIEW_CLEAN = JSON.stringify({ summary: 'It searches and replies.', concerns: [] });
  const REFINED_REPLY = JSON.stringify({
    name: 'Find tickets',
    steps: [
      {
        name: 'Search',
        instruction: 'Search with {{tool:jira_search_issues}}',
        tool: 'jira_search_issues',
        saveAs: 'the search',
      },
      {
        name: 'Reply',
        instruction: 'Tell the user what was found: {{var:the search}}',
        tool: null,
        saveAs: null,
      },
    ],
  });

  it('feeds reviewer concerns back and returns the refined, clean draft', async () => {
    replies = [GOOD_REPLY, REVIEW_CONCERN, REFINED_REPLY, REVIEW_CLEAN];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS, {
      refineWithReview: true,
    });
    if ('error' in result) throw new Error(result.error);
    // draft → review → redraft → review, in that order.
    expect(requests).toHaveLength(4);
    expect(result.steps).toHaveLength(2);
    expect(actionOf(result.steps[1]).name).toBe('Reply');
    expect(result.concerns).toBeUndefined();

    // The redraft request carried the reviewer's finding and the rule about
    // asking the user instead of guessing.
    const feedback = JSON.stringify(requests[2].messages);
    expect(feedback).toContain('flagged these gaps');
    expect(feedback).toContain('Nothing tells the user what was found.');
    expect(feedback).toContain('questions');
  });

  it('keeps the pre-refine draft, concerns attached, when the redraft regresses', async () => {
    replies = [GOOD_REPLY, REVIEW_CONCERN, 'not json at all'];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS, {
      refineWithReview: true,
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.steps).toHaveLength(1);
    expect(result.concerns).toEqual([
      { issue: 'Nothing tells the user what was found.', fix: 'Add a step that replies.' },
    ]);
  });

  it('returns the draft untouched when the review itself is unusable', async () => {
    replies = [GOOD_REPLY, 'total garbage'];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS, {
      refineWithReview: true,
    });
    if ('error' in result) throw new Error(result.error);
    expect(requests).toHaveLength(2);
    expect(result.steps).toHaveLength(1);
    expect(result.concerns).toBeUndefined();
  });

  it('stops after the round limit and reports the still-open concerns', async () => {
    replies = [
      GOOD_REPLY,
      REVIEW_CONCERN,
      REFINED_REPLY,
      REVIEW_CONCERN,
      REFINED_REPLY,
      REVIEW_CONCERN,
    ];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS, {
      refineWithReview: true,
    });
    if ('error' in result) throw new Error(result.error);
    // 1 draft + 3 reviews + 2 redrafts — the loop is bounded.
    expect(requests).toHaveLength(6);
    expect(result.concerns).toHaveLength(1);
  });
});

describe('questions and edge-case reasoning', () => {
  it('surfaces the model’s questions for the user', async () => {
    replies = [
      JSON.stringify({
        name: 'Find tickets',
        steps: [
          {
            name: 'Search',
            instruction: 'Search the project the user names with {{tool:jira_search_issues}}',
            tool: 'jira_search_issues',
          },
        ],
        questions: ['Which Jira project should be searched?', 42, '   '],
        edgeCases: ['Empty search results are reported, not treated as failure.'],
      }),
    ];

    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    // Non-strings and blanks drop; the real question survives.
    expect(result.questions).toEqual(['Which Jira project should be searched?']);
  });

  it('asks the model to think through edge cases and to ask instead of guessing', async () => {
    replies = [GOOD_REPLY];
    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const prompt = JSON.stringify(requests[0].messages);
    expect(prompt).toContain('EDGE CASES');
    expect(prompt).toContain('edgeCases');
    expect(prompt).toContain('NEVER invent specifics');
    expect(prompt).toContain('questions');
  });
});

describe('the interactive draft path costs one model call', () => {
  it('returns as soon as a clean reply parses, without a review round trip', async () => {
    replies = [GOOD_REPLY];
    // No refineWithReview: this is what the builder's Draft button sends.
    const result = await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);
    if ('error' in result) throw new Error(result.error);
    expect(result.steps).toHaveLength(1);
    // The whole point of the change: one call, not draft + review + refine.
    expect(requests).toHaveLength(1);
  });
});

describe('drafting an ask that collects a form', () => {
  it('offers the form vocabulary and a reason to prefer it', async () => {
    replies = [GOOD_REPLY];
    await draftAgentFromProse(db, 't1', 'find my tickets please', TOOLS);

    const prompt = JSON.stringify(requests[0].messages);
    // The shape, and the judgement call that decides between the two —
    // a model told only that fields exist writes the plain box anyway.
    expect(prompt).toContain('ask collects EITHER one plain answer');
    expect(prompt).toContain('choice');
    expect(prompt).toContain('customfield_10016');
    expect(prompt).toContain('PREFER FIELDS');
  });

  it('builds the fields, binds each name, and needs no saveAs', async () => {
    replies = [
      JSON.stringify({
        name: 'Reconcile',
        steps: [
          {
            kind: 'ask',
            name: 'Where do these go?',
            message: 'Which issue tracks this work?',
            mode: 'input',
            fields: [
              { name: 'the issue key', label: 'Which issue?', type: 'text', required: true },
              {
                name: 'the points',
                label: 'Story Points',
                type: 'number',
                required: false,
                min: 1,
                max: 13,
                key: 'customfield_10016',
              },
              {
                name: 'the comments',
                label: 'Which comments?',
                type: 'multi',
                options: ['decision 1', 'risk 2'],
              },
            ],
            onApproved: [
              {
                name: 'Post them',
                instruction: 'Post {{var:the comments}} to {{var:the issue key}}',
                tool: 'jira_search_issues',
              },
            ],
          },
        ],
      }),
    ];

    const result = await draftAgentFromProse(db, 't1', 'ask me where the decisions go', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const ask = askOf(result.steps[0]);

    expect(ask.mode).toBe('input');
    // A form binds its own names, so there is no single answer to name.
    expect(ask.saveAs).toBeUndefined();
    expect(ask.fields?.map((field) => field.name)).toEqual([
      'the issue key',
      'the points',
      'the comments',
    ]);
    expect(ask.fields?.[1]).toMatchObject({
      type: 'number',
      min: 1,
      max: 13,
      key: 'customfield_10016',
    });
    // And the names are BOUND: the step on the answered path chips them,
    // which only parses because the fields registered them.
    const posting = actionOf(ask.onApproved.steps[0]);
    expect(posting.instruction).toContainEqual({ t: 'var', name: 'the comments' });
    expect(posting.instruction).toContainEqual({ t: 'var', name: 'the issue key' });
  });

  it('rescues a one-option choice as text rather than refusing the draft', async () => {
    replies = [
      JSON.stringify({
        name: 'Reconcile',
        steps: [
          {
            kind: 'ask',
            name: 'Where?',
            message: 'Which issue?',
            mode: 'input',
            fields: [
              { name: 'the issue key', label: 'Which issue?', type: 'choice', options: ['CIO-12'] },
            ],
          },
        ],
      }),
    ];

    const result = await draftAgentFromProse(db, 't1', 'ask me where', TOOLS);
    if ('error' in result) throw new Error(result.error);
    const ask = askOf(result.steps[0]);
    // Usable draft, and the person is told what was changed under them.
    expect(ask.fields?.[0]).toMatchObject({ name: 'the issue key', type: 'text' });
    expect(ask.fields?.[0]?.options).toBeUndefined();
    // And the model is told what was changed under it, on the corrective
    // round trip that every soft problem earns.
    expect(JSON.stringify(requests[1].messages)).toContain('fewer than two options');
  });
});
