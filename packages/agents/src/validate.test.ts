/**
 * The rules a saved agent is trusted to satisfy. The ones worth pinning are
 * the ones the platform promises: the 5-attempt ceiling holds no matter
 * what a client sends, a step never carries two tools, failure handling
 * only names conditions the tool actually enumerates, and a var chip never
 * dangles.
 */

import { randomUUID } from 'node:crypto';
import {
  normalizeAgentDraft,
  validateAgentDraft,
  type AgentDraft,
  type ToolDescriptorLike,
} from './validate';
import type { AgentStep, InstructionSegment } from './steps';

const TOOLS: ToolDescriptorLike[] = [
  {
    name: 'jira_create_issue',
    appOnly: false,
    outcomes: {
      failures: [
        { code: 'project-not-found' },
        { code: 'not-found' },
        { code: 'no-permission' },
        { code: 'other' },
      ],
    },
  },
  {
    name: 'jira_get_issue',
    appOnly: false,
    outcomes: { failures: [{ code: 'not-found' }, { code: 'other' }] },
  },
  {
    name: 'jira_create_issue_confirm',
    appOnly: true,
    outcomes: { failures: [{ code: 'other' }] },
  },
];

const text = (v: string): InstructionSegment => ({ t: 'text', v });
const toolChip = (name: string): InstructionSegment => ({ t: 'tool', name });
const varChip = (name: string): InstructionSegment => ({ t: 'var', name });

function step(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    id: randomUUID(),
    name: 'Find the ticket',
    instruction: [text('Look up the ticket with '), toolChip('jira_get_issue')],
    tool: 'jira_get_issue',
    maxAttempts: 3,
    failureHandling: [],
    ...overrides,
  };
}

function draft(overrides: Partial<AgentDraft> = {}): AgentDraft {
  return {
    name: 'Ticket helper',
    steps: { version: 1, steps: [step()] },
    triggers: [],
    enabled: false,
    llmModelId: null,
    ...overrides,
  };
}

const messagesOf = (issues: { message: string }[]) => issues.map((issue) => issue.message);

describe('normalizeAgentDraft', () => {
  it('clamps attempts to the platform ceiling', () => {
    const normalized = normalizeAgentDraft(
      draft({ steps: { version: 1, steps: [step({ maxAttempts: 99 })] } })
    );
    expect(normalized.steps.steps[0]?.maxAttempts).toBe(10);
  });

  it('floors attempts at one and rounds fractions', () => {
    const normalized = normalizeAgentDraft(
      draft({
        steps: {
          version: 1,
          steps: [step({ maxAttempts: 0 }), step({ maxAttempts: 2.6 }), step({ maxAttempts: NaN })],
        },
      })
    );
    expect(normalized.steps.steps.map((s) => s.maxAttempts)).toEqual([1, 3, 1]);
  });
});

describe('validateAgentDraft', () => {
  it('accepts a well-formed draft', () => {
    expect(validateAgentDraft(draft(), TOOLS)).toEqual([]);
  });

  it('rejects a second tool chip in a step', () => {
    const bad = step({
      instruction: [toolChip('jira_get_issue'), text(' then '), toolChip('jira_create_issue')],
    });
    const issues = validateAgentDraft(draft({ steps: { version: 1, steps: [bad] } }), TOOLS);
    expect(messagesOf(issues)).toContain('A step can use one skill — remove the extra skill chip.');
  });

  it('rejects a tool chip that contradicts the step tool', () => {
    const bad = step({ instruction: [toolChip('jira_create_issue')], tool: 'jira_get_issue' });
    const issues = validateAgentDraft(draft({ steps: { version: 1, steps: [bad] } }), TOOLS);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects a tool outside the caller projection, and app-only tools', () => {
    const unknown = step({ tool: 'outlook_send_mail', instruction: [text('send it')] });
    const appOnly = step({ tool: 'jira_create_issue_confirm', instruction: [text('confirm')] });
    const issues = validateAgentDraft(
      draft({ steps: { version: 1, steps: [unknown, appOnly] } }),
      TOOLS
    );
    expect(messagesOf(issues)).toContain(
      'This skill is not available to you — pick one from the list.'
    );
    expect(messagesOf(issues)).toContain('This skill cannot be used in an agent step.');
  });

  it('allows a tool-free reasoning step, but not failure handling on it', () => {
    const reasoning = step({ tool: null, instruction: [text('Summarize the situation')] });
    expect(validateAgentDraft(draft({ steps: { version: 1, steps: [reasoning] } }), TOOLS)).toEqual(
      []
    );

    const withHandling = step({
      tool: null,
      instruction: [text('Summarize')],
      failureHandling: [{ outcome: 'other', action: 'exit' }],
    });
    const issues = validateAgentDraft(
      draft({ steps: { version: 1, steps: [withHandling] } }),
      TOOLS
    );
    expect(messagesOf(issues)).toContain(
      'A step without a skill has no failure conditions to handle.'
    );
  });

  it('rejects failure handling for a condition the tool does not enumerate', () => {
    const bad = step({
      failureHandling: [{ outcome: 'transition-not-allowed', action: 'exit' }],
    });
    const issues = validateAgentDraft(draft({ steps: { version: 1, steps: [bad] } }), TOOLS);
    expect(messagesOf(issues)).toContain(
      'This failure condition does not belong to the chosen skill.'
    );
  });

  it('requires guidance on retry, and lets guidance carry several tools', () => {
    const missingGuidance = step({
      failureHandling: [{ outcome: 'not-found', action: 'retry' }],
    });
    expect(
      messagesOf(
        validateAgentDraft(draft({ steps: { version: 1, steps: [missingGuidance] } }), TOOLS)
      )
    ).toContain('Say what the agent should do differently.');

    const laxGuidance = step({
      failureHandling: [
        {
          outcome: 'not-found',
          action: 'retry',
          guidance: [
            text('Search first with '),
            toolChip('jira_get_issue'),
            text(' then create with '),
            toolChip('jira_create_issue'),
          ],
        },
      ],
    });
    expect(
      validateAgentDraft(draft({ steps: { version: 1, steps: [laxGuidance] } }), TOOLS)
    ).toEqual([]);
  });

  it('rejects var chips bound nowhere, and accepts every binding source', () => {
    const producer = step({ saveAs: 'theTicket' });
    const consumer = step({
      instruction: [text('Comment on '), varChip('theTicket'), varChip('user.email')],
    });
    const dangling = step({ instruction: [text('Use '), varChip('nonsense')] });

    expect(
      validateAgentDraft(draft({ steps: { version: 1, steps: [producer, consumer] } }), TOOLS)
    ).toEqual([]);

    const issues = validateAgentDraft(draft({ steps: { version: 1, steps: [dangling] } }), TOOLS);
    expect(messagesOf(issues).some((m) => m.includes('"nonsense"'))).toBe(true);
  });

  it('accepts trigger-provided variables only when the trigger is attached', () => {
    const consumer = step({ instruction: [text('Read '), varChip('trigger.subject')] });
    const withTrigger = draft({
      steps: { version: 1, steps: [consumer] },
      triggers: [{ kind: 'event', eventId: 'microsoft/mail.received' }],
    });
    expect(validateAgentDraft(withTrigger, TOOLS)).toEqual([]);

    const withoutTrigger = draft({ steps: { version: 1, steps: [consumer] } });
    expect(validateAgentDraft(withoutTrigger, TOOLS).length).toBeGreaterThan(0);
  });

  it('requires a trigger before the agent can be enabled', () => {
    const issues = validateAgentDraft(draft({ enabled: true }), TOOLS);
    expect(messagesOf(issues)).toContain('Add at least one trigger before turning the agent on.');
  });

  it('rejects duplicate saveAs names', () => {
    const a = step({ saveAs: 'result' });
    const b = step({ saveAs: 'result' });
    const issues = validateAgentDraft(draft({ steps: { version: 1, steps: [a, b] } }), TOOLS);
    expect(messagesOf(issues)).toContain('Two steps save their result under the same name.');
  });
});

/**
 * Branch rules — version 2 documents. The version recompute is the load-
 * bearing one: the SERVER decides 1 vs 2, and a linear doc must come out
 * byte-identical to what pre-branch builds wrote.
 */
import { randomUUID as uuid } from 'node:crypto';
import type { BranchStep } from './steps';

function branchNode(overrides: Partial<BranchStep> = {}): BranchStep {
  return {
    id: uuid(),
    kind: 'branch',
    name: 'Anything urgent?',
    condition: [text('Did the search find anything urgent?')],
    paths: [
      { id: uuid(), name: 'Yes', steps: [step({ name: 'Escalate' })] },
      { id: uuid(), name: 'Otherwise', steps: [] },
    ],
    maxAttempts: 2,
    ...overrides,
  };
}

describe('branch validation', () => {
  it('accepts a well-formed branch with an empty else path', () => {
    const issues = validateAgentDraft(
      draft({ steps: { version: 2, steps: [step(), branchNode()] } }),
      TOOLS
    );
    expect(issues).toEqual([]);
  });

  it('rejects a tool chip in the condition', () => {
    const issues = validateAgentDraft(
      draft({
        steps: {
          version: 2,
          steps: [branchNode({ condition: [text('Check with '), toolChip('jira_get_issue')] })],
        },
      }),
      TOOLS
    );
    expect(messagesOf(issues)).toContain(
      'A branch can’t use a skill — do that work in a step above, save the result, and branch on it.'
    );
  });

  it('rejects a branch whose paths are both empty', () => {
    const issues = validateAgentDraft(
      draft({
        steps: {
          version: 2,
          steps: [
            branchNode({
              paths: [
                { id: uuid(), name: 'Yes', steps: [] },
                { id: uuid(), name: 'No', steps: [] },
              ],
            }),
          ],
        },
      }),
      TOOLS
    );
    expect(messagesOf(issues)).toContain(
      'This branch does nothing — add a step to a path or remove the branch.'
    );
  });

  it('addresses nested issues with the recursive path grammar', () => {
    const bad = step({ name: '' });
    const issues = validateAgentDraft(
      draft({
        steps: {
          version: 2,
          steps: [
            branchNode({
              paths: [
                { id: uuid(), name: 'Yes', steps: [bad] },
                { id: uuid(), name: 'No', steps: [] },
              ],
            }),
          ],
        },
      }),
      TOOLS
    );
    expect(issues.some((issue) => issue.path === 'steps.0.paths.0.steps.0.name')).toBe(true);
  });

  it('rejects nesting beyond one branch inside a branch', () => {
    const tooDeep = branchNode({
      paths: [
        {
          id: uuid(),
          name: 'Yes',
          steps: [
            branchNode({
              paths: [
                { id: uuid(), name: 'Deeper', steps: [branchNode()] },
                { id: uuid(), name: 'No', steps: [] },
              ],
            }),
          ],
        },
        { id: uuid(), name: 'No', steps: [] },
      ],
    });
    const issues = validateAgentDraft(draft({ steps: { version: 2, steps: [tooDeep] } }), TOOLS);
    expect(messagesOf(issues)).toContain(
      'Branches can only nest one level deep — move this one up.'
    );
  });

  it('lets a save inside one path be referenced after the branch (permissive scope)', () => {
    const saver = step({ name: 'Look up', saveAs: 'ticket' });
    const after = step({
      name: 'Use it',
      instruction: [text('Summarize '), varChip('ticket')],
      tool: null,
    });
    const issues = validateAgentDraft(
      draft({
        steps: {
          version: 2,
          steps: [
            branchNode({
              paths: [
                { id: uuid(), name: 'Yes', steps: [saver] },
                { id: uuid(), name: 'No', steps: [] },
              ],
            }),
            after,
          ],
        },
      }),
      TOOLS
    );
    expect(issues).toEqual([]);
  });
});

describe('normalizeAgentDraft with branches', () => {
  it('recomputes the version: 2 iff a branch exists', () => {
    const withBranch = normalizeAgentDraft(
      draft({ steps: { version: 1 as const, steps: [step(), branchNode()] } })
    );
    expect(withBranch.steps.version).toBe(2);

    const linear = normalizeAgentDraft(draft({ steps: { version: 2, steps: [step()] } }));
    expect(linear.steps.version).toBe(1);
  });

  it('keeps a linear doc byte-identical to the pre-branch shape', () => {
    const plain = step({ name: '  Trim me  ', kind: 'action' });
    const normalized = normalizeAgentDraft(draft({ steps: { version: 1, steps: [plain] } }));
    const out = normalized.steps.steps[0];
    // The optional discriminant is STRIPPED, not just undefined-valued — the
    // serialized row must match what pre-branch builds wrote.
    expect('kind' in out).toBe(false);
    expect(out.name).toBe('Trim me');
  });

  it('clamps branch attempts and trims branch and path names', () => {
    const messy = branchNode({ name: '  If urgent  ', maxAttempts: 99 });
    messy.paths[0].name = '  Yes  ';
    const normalized = normalizeAgentDraft(draft({ steps: { version: 2, steps: [messy] } }));
    const out = normalized.steps.steps[0];
    if (out.kind !== 'branch') throw new Error('expected a branch');
    expect(out.name).toBe('If urgent');
    expect(out.maxAttempts).toBe(10);
    expect(out.paths[0].name).toBe('Yes');
  });
});
