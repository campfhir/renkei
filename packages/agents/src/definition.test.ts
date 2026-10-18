import {
  INSTRUCTION_SECTIONS,
  MAX_AGENT_TOOLS,
  agentDefinitionOf,
  instructionsHaveContent,
  instructionsSkeleton,
  isAgentDefinition,
  normalizeAgentDraft,
  validateAgentDraft,
  type AgentDraft,
} from './definition';

const draft: AgentDraft = {
  name: '  Triage  ',
  instructions: '## Goal\n\nTriage new tickets.\n\n',
  tools: ['jira_search_issues', ' jira_search_issues ', 'jira_add_comment', ''],
  triggers: [],
  enabled: false,
  llmModelId: null,
  guardrails: '   ',
  canAskQuestions: false,
  autoAcceptActions: false,
};

const tools = [
  { name: 'jira_search_issues', appOnly: false },
  { name: 'jira_add_comment', appOnly: false },
  { name: 'app_only_confirm', appOnly: true },
];

describe('normalizeAgentDraft', () => {
  it('trims, dedupes the tool list and drops blank guardrails', () => {
    const normalized = normalizeAgentDraft(draft);
    expect(normalized.name).toBe('Triage');
    expect(normalized.instructions).toBe('## Goal\n\nTriage new tickets.');
    expect(normalized.tools).toEqual(['jira_search_issues', 'jira_add_comment']);
    expect(normalized.guardrails).toBeNull();
  });
});

describe('validateAgentDraft', () => {
  it('accepts a draft whose tools the owner has', () => {
    expect(validateAgentDraft(normalizeAgentDraft(draft), tools)).toEqual([]);
  });

  it('refuses instructions that are only the skeleton', () => {
    const issues = validateAgentDraft(
      normalizeAgentDraft({ ...draft, instructions: instructionsSkeleton() }),
      tools
    );
    expect(issues.map((issue) => issue.path)).toEqual(['instructions']);
  });

  it('names a tool the owner does not have, and one that is app-only', () => {
    const issues = validateAgentDraft(
      normalizeAgentDraft({ ...draft, tools: ['gone_tool', 'app_only_confirm'] }),
      tools
    );
    expect(issues.map((issue) => issue.path)).toEqual(['tools.0', 'tools.1']);
  });

  it('caps the tool selection', () => {
    const many = Array.from({ length: MAX_AGENT_TOOLS + 1 }, (_, index) => `t${index}`);
    const issues = validateAgentDraft(
      { ...draft, tools: many },
      many.map((name) => ({ name, appOnly: false }))
    );
    expect(issues.map((issue) => issue.path)).toEqual(['tools']);
  });

  it('needs a trigger before the agent can be on', () => {
    const issues = validateAgentDraft(normalizeAgentDraft({ ...draft, enabled: true }), tools);
    expect(issues.map((issue) => issue.path)).toEqual(['triggers']);
  });
});

describe('the instruction skeleton', () => {
  it('carries one heading per section and no content', () => {
    const skeleton = instructionsSkeleton();
    for (const section of INSTRUCTION_SECTIONS) expect(skeleton).toContain(`## ${section.heading}`);
    expect(instructionsHaveContent(skeleton)).toBe(false);
    expect(instructionsHaveContent(`${skeleton}Do the thing.`)).toBe(true);
  });
});

describe('definitions', () => {
  it('reads a row and guards a snapshot', () => {
    const definition = agentDefinitionOf({ instructions: 'Go.', tools: ['a', 3, 'b'] });
    expect(definition).toEqual({ instructions: 'Go.', tools: ['a', 'b'] });
    expect(isAgentDefinition(definition)).toBe(true);
    expect(isAgentDefinition({ version: 9, steps: [] })).toBe(false);
    expect(isAgentDefinition(null)).toBe(false);
  });
});
