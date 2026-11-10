import { MAX_AGENT_TOOLS, instructionsSkeleton, type TriggerDraft } from '@renkei/agents';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import type { StoredAgent } from '@/lib/agents/store';
import {
  agentDraftOf,
  autoAcceptNote,
  builderReducer,
  canDraft,
  canSave,
  clientIssuesOf,
  defaultModelLabel,
  draftButtonLabel,
  draftRequestOf,
  draftStatus,
  hasRealInstructions,
  hasSection,
  initBuilder,
  instructionIssuesOf,
  issuesAt,
  overviewHref,
  saveAsksFirst,
  saveLabel,
  saveRequestOf,
  saveSummary,
  selectedTriggerOf,
  shownIssues,
  type BuilderAction,
  type BuilderState,
} from './agent-builder.model';

function tool(name: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name,
    connector: 'agents',
    kind: 'read',
    title: null,
    description: null,
    appOnly: false,
    previewOf: null,
    widgetKind: null,
    outcomes: { success: { label: 'ok' }, failures: [] },
    ...overrides,
  };
}

const TOOLS = [tool('agent_list'), tool('agent_get'), tool('card_create', { kind: 'act' })];

const INSTRUCTIONS = [
  '## Goal',
  '',
  'Each morning, find the agents nobody has run lately and list them.',
  '',
  '## Done when',
  '',
  'Every idle agent is listed — or there were none.',
].join('\n');

const API_TRIGGER: TriggerDraft = { kind: 'api', inputs: [] };

function fold(actions: BuilderAction[], from: BuilderState = initBuilder()): BuilderState {
  return actions.reduce(builderReducer, from);
}

function written(from: BuilderState = initBuilder()): BuilderState {
  return fold(
    [
      { type: 'nameChanged', value: 'Idle agents digest' },
      { type: 'instructionsChanged', value: INSTRUCTIONS },
    ],
    from
  );
}

function storedAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  return {
    id: 'agent-1',
    name: 'Ticket greeter',
    description: null,
    descriptionStatus: 'ready',
    reviewNotes: [{ issue: 'It never says when it is done.', fix: 'Add a Done when.' }],
    instructions: INSTRUCTIONS,
    tools: ['agent_get'],
    revision: 3,
    llmModelId: null,
    enabled: true,
    guardrails: null,
    canAskQuestions: false,
    autoAcceptActions: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    triggers: [
      {
        id: 'trigger-1',
        draft: API_TRIGGER,
        enabled: true,
        lastFiredAt: null,
        lastError: null,
        nextRunAt: null,
        keyHint: 'ab12',
      },
    ],
    ...overrides,
  };
}

const issuesOf = (state: BuilderState) => clientIssuesOf(state, TOOLS);

describe('a new agent', () => {
  it('starts from the section skeleton, with the describe box open and Save off', () => {
    const state = initBuilder();
    expect(state.instructions).toBe(instructionsSkeleton());
    expect(state.instructions).toMatch(/## Goal/);
    expect(state.proseOpen).toBe(true);
    expect(canSave(state, issuesOf(state))).toBe(false);
    expect(saveLabel(state)).toBe('Save');
  });

  it('does not mark the untouched skeleton red, though it still blocks Save', () => {
    const state = fold([{ type: 'nameChanged', value: 'Digest' }]);
    const issues = issuesOf(state);
    expect(issuesAt(issues, 'instructions')).toHaveLength(1);
    expect(instructionIssuesOf(state, issues)).toEqual([]);
    expect(canSave(state, issues)).toBe(false);
    expect(saveSummary(state, issues)).toBe('1 thing to fix before saving');
  });

  it('counts what is left to fix beside Save', () => {
    const state = initBuilder();
    expect(saveSummary(state, issuesOf(state))).toBe('2 things to fix before saving');
  });

  it('marks instructions that are only headings once the person has written something', () => {
    const state = fold([{ type: 'instructionsChanged', value: '## Goal\n\n## Rules\n' }]);
    expect(hasRealInstructions(state)).toBe(true);
    expect(instructionIssuesOf(state, issuesOf(state))).toEqual([
      'Write the instructions — what the agent should achieve and how.',
    ]);
  });

  it('turns Save on with a name and real instructions, and says it will start off', () => {
    const state = written();
    const issues = issuesOf(state);
    expect(issues).toEqual([]);
    expect(canSave(state, issues)).toBe(true);
    expect(saveSummary(state, issues)).toBe(
      'Saved agents start turned off — you review, then turn them on.'
    );
  });

  it('keeps Save off while a save is in flight, and says so', () => {
    const state = fold([{ type: 'saveSent' }], written());
    expect(canSave(state, issuesOf(state))).toBe(false);
    expect(saveLabel(state)).toBe('Saving…');
  });
});

describe('tools', () => {
  it('keeps Save off past the tool limit, with the reason under Tools', () => {
    const many = Array.from({ length: MAX_AGENT_TOOLS + 1 }, (_, index) => `tool_${index}`);
    const tools = many.map((name) => tool(name));
    const state = fold([{ type: 'toolsChanged', tools: many }], written());
    const issues = clientIssuesOf(state, tools);
    expect(canSave(state, issues)).toBe(false);
    expect(issuesAt(issues, 'tools')).toEqual([
      `Select at most ${MAX_AGENT_TOOLS} tools — every one is described to the model on every call.`,
    ]);
  });

  it('refuses a tool the owner no longer has, under Tools', () => {
    const state = fold([{ type: 'toolsChanged', tools: ['agent_get', 'gone_tool'] }], written());
    const issues = issuesOf(state);
    expect(canSave(state, issues)).toBe(false);
    expect(issuesAt(issues, 'tools')).toEqual([
      expect.stringContaining('The tool "gone_tool" is not available'),
    ]);
  });
});

describe('Save', () => {
  it('creates a new agent straight away, sending everything the builder holds', () => {
    const state = fold(
      [
        { type: 'toolsChanged', tools: ['agent_list', 'agent_get'] },
        { type: 'flagChanged', flag: 'canAskQuestions', value: true },
        { type: 'guardrailsChanged', value: '   ' },
        { type: 'triggerChosen', draft: API_TRIGGER },
      ],
      written()
    );
    expect(saveAsksFirst(state)).toBe(false);
    expect(saveRequestOf(state)).toEqual({
      url: '/api/agents',
      method: 'POST',
      body: {
        name: 'Idle agents digest',
        instructions: INSTRUCTIONS,
        tools: ['agent_list', 'agent_get'],
        triggers: [{ draft: API_TRIGGER, enabled: true }],
        enabled: false,
        llmModelId: null,
        // Blank guardrails are none at all.
        guardrails: null,
        canAskQuestions: true,
        autoAcceptActions: false,
        refreshDescription: true,
      },
    });
  });

  it('on an existing agent asks first, then updates it in place, keeping it on as it was', () => {
    const editing = initBuilder(storedAgent());
    expect(saveLabel(editing)).toBe('Update');
    expect(saveAsksFirst(editing)).toBe(true);
    const confirming = fold(
      [
        { type: 'saveFailed', error: 'old' },
        { type: 'confirmOpened' },
        { type: 'flagChanged', flag: 'autoAcceptActions', value: true },
      ],
      editing
    );
    expect(confirming.saveModal).toEqual({ stage: 'confirm' });
    expect(confirming.saveError).toBeNull();
    const request = saveRequestOf(confirming);
    expect(request.url).toBe('/api/agents/agent-1');
    expect(request.method).toBe('PUT');
    expect(request.body).toMatchObject({ enabled: true, autoAcceptActions: true });
    expect(request.body.triggers).toEqual([
      { id: 'trigger-1', draft: API_TRIGGER, enabled: true, keyHint: 'ab12', lastError: null },
    ]);
  });

  it('shows what the server refused in place of the local check, and closes the confirm stage', () => {
    const refused = fold(
      [
        { type: 'confirmOpened' },
        { type: 'saveSent' },
        { type: 'saveRefused', issues: [{ path: 'tools.0', message: 'Not yours any more.' }] },
      ],
      initBuilder(storedAgent())
    );
    expect(refused.saving).toBe(false);
    expect(refused.saveModal).toBeNull();
    const shown = shownIssues(refused, issuesOf(refused));
    expect(issuesAt(shown, 'tools')).toEqual(['Not yours any more.']);
    // The local check passes, so Save stays on for another try.
    expect(canSave(refused, issuesOf(refused))).toBe(true);
  });

  it('drops the server’s refusal once the person edits what it was about', () => {
    const refused = fold(
      [{ type: 'saveRefused', issues: [{ path: 'instructions', message: 'Too vague.' }] }],
      written()
    );
    expect(instructionIssuesOf(refused, shownIssues(refused, issuesOf(refused)))).toEqual([
      'Too vague.',
    ]);
    for (const edit of [
      { type: 'instructionsChanged', value: `${INSTRUCTIONS}\nMore.` },
      { type: 'toolsChanged', tools: [] },
      { type: 'guardrailsChanged', value: 'Never email.' },
      { type: 'triggerChosen', draft: API_TRIGGER },
    ] satisfies BuilderAction[]) {
      expect(builderReducer(refused, edit).serverIssues).toEqual([]);
    }
  });

  it('a failed save says why and lets the person try again', () => {
    const failed = fold([{ type: 'saveSent' }, { type: 'saveFailed', error: null }], written());
    expect(failed.saveError).toBe('The agent could not be saved.');
    expect(canSave(failed, issuesOf(failed))).toBe(true);
    const again = builderReducer(failed, { type: 'saveSent' });
    expect(again.saveError).toBeNull();
  });

  it('a create adopts the new id and stays saving while the overview opens', () => {
    const saved = fold(
      [{ type: 'saveSent' }, { type: 'saved', response: { agentId: 'agent-9', apiKeys: [] } }],
      written()
    );
    expect(saved.agentId).toBe('agent-9');
    expect(saved.saving).toBe(true);
    expect(saved.saveModal).toBeNull();
    expect(overviewHref(saved.agentId)).toBe('/agents/agent-9');
    expect(overviewHref(null)).toBe('/agents');
  });

  it('shows freshly minted API keys once, and takes the stored triggers back', () => {
    const agent = storedAgent({ id: 'agent-9' });
    const keys = [{ triggerId: 'trigger-1', key: 'rk_secret' }];
    const saved = fold(
      [
        { type: 'triggerChosen', draft: API_TRIGGER },
        { type: 'saveSent' },
        { type: 'saved', response: { agentId: 'agent-9', apiKeys: keys, agent } },
      ],
      written()
    );
    expect(saved.saving).toBe(false);
    expect(saved.saveModal).toEqual({ stage: 'keys', apiKeys: keys });
    expect(saved.triggers).toEqual([
      { id: 'trigger-1', draft: API_TRIGGER, enabled: true, keyHint: 'ab12', lastError: null },
    ]);
    expect(saved.selection).toEqual({ type: 'trigger', index: 0 });
  });
});

describe('describing the agent and drafting it', () => {
  it('offers drafting once there are ten characters to go on, and not while one runs', () => {
    expect(canDraft(fold([{ type: 'proseChanged', value: '  too short ' }]))).toBe(false);
    const ready = fold([{ type: 'proseChanged', value: 'List the idle agents.' }]);
    expect(canDraft(ready)).toBe(true);
    expect(canDraft(builderReducer(ready, { type: 'draftStarted', mode: 'create' }))).toBe(false);
  });

  it('a first draft sends no current instructions and asks for triggers', () => {
    const state = fold([
      { type: 'proseChanged', value: 'Every morning, list the agents nobody has run lately.' },
    ]);
    expect(draftRequestOf(state)).toEqual({
      revising: false,
      body: {
        text: 'Every morning, list the agents nobody has run lately.',
        guardrails: null,
        current: null,
        suggestTriggers: true,
        triggerVars: [],
      },
    });
  });

  it('with real instructions it revises: they go along, and existing triggers are not re-suggested', () => {
    const state = fold(
      [
        { type: 'proseChanged', value: 'Also post the list to the team.' },
        { type: 'toolsChanged', tools: ['agent_list'] },
        {
          type: 'triggerChosen',
          draft: { kind: 'api', inputs: [{ name: 'team', label: 'Team' }] },
        },
      ],
      initBuilder(storedAgent({ triggers: [] }))
    );
    const request = draftRequestOf(state);
    expect(request.revising).toBe(true);
    expect(request.body).toMatchObject({
      current: { instructions: INSTRUCTIONS, tools: ['agent_list'] },
      agentId: 'agent-1',
      triggerVars: [expect.objectContaining({ name: 'trigger.team' })],
    });
    expect(request.body).not.toHaveProperty('suggestTriggers');
  });

  it('a finished draft fills the builder and turns questions on', () => {
    const state = fold([
      { type: 'draftStarted', mode: 'create' },
      { type: 'draftQueued', draftId: 'draft-1' },
      {
        type: 'draftArrived',
        localTimezone: 'Europe/Berlin',
        result: {
          name: 'Idle agents digest',
          instructions: INSTRUCTIONS,
          tools: ['agent_list', 7],
          questions: ['Which agents should it look at?'],
          canAskQuestions: true,
          notes: ['Left out “slack_post”: it is not one of your tools.'],
          guardrails: 'Never email anyone.',
        },
      },
    ]);
    expect(state).toMatchObject({
      drafting: false,
      draftId: null,
      drafted: true,
      name: 'Idle agents digest',
      instructions: INSTRUCTIONS,
      tools: ['agent_list'],
      draftQuestions: ['Which agents should it look at?'],
      draftNotes: ['Left out “slack_post”: it is not one of your tools.'],
      canAskQuestions: true,
      guardrails: 'Never email anyone.',
    });
    expect(draftButtonLabel(state)).toBe('Draft again');
  });

  it('a draft never renames the agent, replaces guardrails or triggers, or turns questions off', () => {
    const start = fold([
      { type: 'nameChanged', value: 'My name' },
      { type: 'guardrailsChanged', value: 'Mine.' },
      { type: 'flagChanged', flag: 'canAskQuestions', value: true },
      { type: 'triggerChosen', draft: API_TRIGGER },
    ]);
    const state = builderReducer(start, {
      type: 'draftArrived',
      localTimezone: 'UTC',
      result: {
        name: 'Drafted name',
        instructions: INSTRUCTIONS,
        guardrails: 'Drafted.',
        canAskQuestions: false,
        triggers: [{ kind: 'schedule', recurrences: [{ every: 'hour' }], timezone: 'UTC' }],
      },
    });
    expect(state.name).toBe('My name');
    expect(state.guardrails).toBe('Mine.');
    expect(state.canAskQuestions).toBe(true);
    expect(state.triggers).toEqual([{ draft: API_TRIGGER, enabled: true }]);
  });

  it('a drafted schedule that names no zone runs in the person’s own', () => {
    const state = fold([
      {
        type: 'draftArrived',
        localTimezone: 'America/Chicago',
        result: {
          instructions: INSTRUCTIONS,
          triggers: [
            { kind: 'schedule', recurrences: [{ every: 'hour' }], timezone: '' },
            { kind: 'nonsense' },
          ],
        },
      },
    ]);
    expect(state.triggers).toEqual([
      {
        draft: { kind: 'schedule', recurrences: [{ every: 'hour' }], timezone: 'America/Chicago' },
        enabled: true,
      },
    ]);
  });

  it('a draft in a shape this build does not know changes nothing and says so', () => {
    const before = fold([{ type: 'draftStarted', mode: 'create' }], written());
    const state = builderReducer(before, {
      type: 'draftArrived',
      localTimezone: 'UTC',
      result: { instructions: '   ' },
    });
    expect(state.instructions).toBe(INSTRUCTIONS);
    expect(state.drafting).toBe(false);
    expect(state.drafted).toBe(false);
    expect(state.draftError).toBe('The draft came back in a shape this build does not understand.');
  });

  it('a failed draft says why, with what was sent when the server kept it', () => {
    const failed = fold([
      { type: 'draftStarted', mode: 'create' },
      { type: 'draftQueued', draftId: 'draft-1' },
      { type: 'draftFailed', error: null, detail: 'POST /v1/messages (redacted)' },
    ]);
    expect(failed).toMatchObject({
      drafting: false,
      draftId: null,
      draftError: 'Drafting failed — try again.',
      draftDetail: 'POST /v1/messages (redacted)',
    });
    // Drafting again clears the last attempt's error and leftovers.
    const again = builderReducer(failed, { type: 'draftStarted', mode: 'create' });
    expect(again).toMatchObject({ draftError: null, draftDetail: null, draftSeconds: 0 });
  });

  it('a draft that could not start says why', () => {
    const state = fold([
      { type: 'draftStarted', mode: 'create' },
      { type: 'draftStartFailed', error: null },
    ]);
    expect(state.drafting).toBe(false);
    expect(state.draftError).toBe('Drafting could not be started — try again.');
  });

  it('says what it is doing as the seconds pass', () => {
    let state = fold([{ type: 'draftStarted', mode: 'create' }]);
    expect(draftStatus(state)).toBe('Sending your description to your org’s model…');
    for (let tick = 0; tick < 3; tick += 1) state = builderReducer(state, { type: 'draftTick' });
    expect(draftStatus(state)).toBe('Writing the instructions and picking the tools…');
    expect(draftStatus({ draftSeconds: 5, draftMode: 'revise' })).toBe(
      'Revising the instructions — applying the change you described…'
    );
    expect(draftStatus({ draftSeconds: 25, draftMode: 'create' })).toMatch(
      /^Still working \(25s\)\. This runs in the background/
    );
    expect(draftButtonLabel(state)).toBe('Drafting…');
  });

  it('the clock only runs while drafting', () => {
    expect(builderReducer(initBuilder(), { type: 'draftTick' }).draftSeconds).toBe(0);
  });

  it('offers a draft that finished while the page was closed, without applying it', () => {
    const offered = fold([
      { type: 'pendingDraftFound', draft: { id: 'draft-2', createdAt: '2026-11-01T08:00:00Z' } },
    ]);
    expect(offered.pendingDraft?.id).toBe('draft-2');
    expect(offered.instructions).toBe(instructionsSkeleton());
    expect(builderReducer(offered, { type: 'pendingDraftDismissed' }).pendingDraft).toBeNull();

    const loaded = builderReducer(offered, {
      type: 'pendingDraftLoaded',
      localTimezone: 'UTC',
      result: { instructions: INSTRUCTIONS, tools: ['agent_get'] },
    });
    expect(loaded.pendingDraft).toBeNull();
    expect(loaded.instructions).toBe(INSTRUCTIONS);
    expect(loaded.tools).toEqual(['agent_get']);
  });

  it('a waiting draft that cannot be loaded goes away and says so', () => {
    const state = fold([
      { type: 'pendingDraftFound', draft: { id: 'draft-2', createdAt: '2026-11-01T08:00:00Z' } },
      { type: 'pendingDraftLoaded', localTimezone: 'UTC', result: null },
    ]);
    expect(state.pendingDraft).toBeNull();
    expect(state.draftError).toBe('That draft could not be loaded.');
  });

  it('on edit the describe box is behind a link, and opens and closes', () => {
    const editing = initBuilder(storedAgent());
    expect(editing.proseOpen).toBe(false);
    expect(builderReducer(editing, { type: 'proseOpened' }).proseOpen).toBe(true);
    expect(fold([{ type: 'proseOpened' }, { type: 'proseClosed' }], editing).proseOpen).toBe(false);
  });
});

describe('triggers', () => {
  it('choosing a trigger adds it and opens its editor', () => {
    const state = fold([
      { type: 'triggerAddOpened' },
      { type: 'triggerChosen', draft: API_TRIGGER },
    ]);
    expect(state.triggers).toEqual([{ draft: API_TRIGGER, enabled: true }]);
    expect(state.selection).toEqual({ type: 'trigger', index: 0 });
    expect(selectedTriggerOf(state)).toEqual({ draft: API_TRIGGER, enabled: true });
  });

  it('editing changes only the open trigger', () => {
    const edited: TriggerDraft = { kind: 'api', inputs: [{ name: 'ticket', label: 'Ticket' }] };
    const state = fold([
      { type: 'triggerChosen', draft: API_TRIGGER },
      { type: 'triggerChosen', draft: API_TRIGGER },
      { type: 'triggerOpened', index: 0 },
      { type: 'triggerEdited', draft: edited },
    ]);
    expect(state.triggers.map((trigger) => trigger.draft)).toEqual([edited, API_TRIGGER]);
  });

  it('removing takes the open trigger away and closes the panel', () => {
    const state = fold([
      { type: 'triggerChosen', draft: API_TRIGGER },
      { type: 'triggerChosen', draft: { kind: 'agent', callerAgentId: 'agent-2' } },
      { type: 'triggerOpened', index: 0 },
      { type: 'triggerRemoved' },
    ]);
    expect(state.triggers).toEqual([
      { draft: { kind: 'agent', callerAgentId: 'agent-2' }, enabled: true },
    ]);
    expect(state.selection).toBeNull();
  });

  it('an existing agent that is on cannot lose its last trigger and still save', () => {
    const state = fold(
      [{ type: 'triggerOpened', index: 0 }, { type: 'triggerRemoved' }],
      initBuilder(storedAgent())
    );
    const issues = issuesOf(state);
    expect(issuesAt(issues, 'triggers')).toEqual([
      'Add at least one trigger before turning the agent on.',
    ]);
    expect(saveSummary(state, issues)).toBe('1 thing to fix before saving');
  });
});

describe('the instructions editor', () => {
  it('ticks the sections present and adds a missing one at the end', () => {
    const state = written();
    expect(hasSection(state.instructions, 'Goal')).toBe(true);
    expect(hasSection(state.instructions, 'Rules')).toBe(false);
    const added = builderReducer(state, { type: 'sectionAdded', heading: 'Rules' });
    expect(added.instructions).toBe(`${INSTRUCTIONS}\n\n## Rules\n\n`);
    expect(hasSection(added.instructions, 'Rules')).toBe(true);
  });
});

describe('worth checking', () => {
  it('shows the saved notes, and replaces them when a re-check finishes', () => {
    const editing = initBuilder(storedAgent());
    expect(editing.checkNotes).toEqual([
      { issue: 'It never says when it is done.', fix: 'Add a Done when.' },
    ]);
    const checked = fold(
      [
        { type: 'recheckStarted' },
        { type: 'recheckDone', agent: storedAgent({ reviewNotes: ['Name the tickets.'] }) },
      ],
      editing
    );
    expect(checked.checking).toBe(false);
    expect(checked.checkNotes).toEqual([{ issue: 'Name the tickets.' }]);
  });

  it('a re-check that times out keeps the last notes; one that fails says why', () => {
    const editing = initBuilder(storedAgent());
    const timedOut = fold(
      [{ type: 'recheckStarted' }, { type: 'recheckDone', agent: null }],
      editing
    );
    expect(timedOut.checkNotes).toEqual(editing.checkNotes);
    const failed = fold(
      [{ type: 'recheckStarted' }, { type: 'recheckFailed', error: 'No model.' }],
      editing
    );
    expect(failed).toMatchObject({ checking: false, saveError: 'No model.' });
  });
});

describe('the switches', () => {
  it('a new agent starts with questions and auto-accept off; the draft carries what is set', () => {
    const state = fold([
      { type: 'flagChanged', flag: 'autoAcceptActions', value: true },
      { type: 'modelChanged', llmModelId: 'model-1' },
    ]);
    expect(agentDraftOf(state)).toMatchObject({
      canAskQuestions: false,
      autoAcceptActions: true,
      llmModelId: 'model-1',
      enabled: false,
    });
  });

  it('says what auto-accept cannot skip under each org policy', () => {
    expect(autoAcceptNote('off')).toMatch(/^Changes from high-risk tools/);
    expect(autoAcceptNote('all')).toMatch(/^Your organization requires a person to accept every/);
    expect(autoAcceptNote('externally_triggered')).toMatch(
      /^Runs started by an email, a message or an API call still wait for you/
    );
  });

  it('names the org default model when there is one', () => {
    expect(defaultModelLabel([{ label: 'Claude', isDefault: true }])).toBe(
      'Organization default (Claude)'
    );
    expect(defaultModelLabel([{ label: 'Claude', isDefault: false }])).toBe('Organization default');
  });
});
