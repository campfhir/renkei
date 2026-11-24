import type { BlockDefinition, PipelineSpec } from '@renkei/ci-blocks';
import {
  askFileRequest,
  askRequest,
  assistantReducer,
  buildingBlockRequest,
  canAsk,
  fileCard,
  initialAssistant,
  proposalCard,
  reuseQuestion,
  type AssistantAction,
  type AssistantAnswer,
  type AssistantState,
} from './pipeline-assistant.model';

const run = (actions: AssistantAction[], from: AssistantState = initialAssistant) =>
  actions.reduce(assistantReducer, from);

const build: BlockDefinition = {
  kind: 'build',
  runsOn: { type: 'hosted', image: 'node:20' },
  inputs: [],
  variables: [],
  consumes: [],
  produces: [{ name: 'dist', paths: ['dist'] }],
  caches: [],
  commands: 'pnpm install --frozen-lockfile\npnpm build',
};
const current: PipelineSpec = {
  checks: [{ block: 'node-test', version: 1, inputs: {} }],
  environments: [],
};
const proposed: PipelineSpec = {
  checks: [
    { block: 'node-test', version: 1, inputs: {} },
    { block: 'build-billing', version: 1, inputs: {} },
  ],
  environments: [{ name: 'production', branch: 'main', steps: [] }],
  blocks: [
    {
      key: 'build-billing',
      name: 'Build billing',
      description: 'pnpm, as the repository builds.',
      version: 1,
      definition: build,
    },
  ],
};
const answer = (overrides: Partial<AssistantAnswer> = {}): AssistantAnswer => ({
  reply: 'I read package.json; it builds with pnpm.',
  proposal: { summary: 'Builds with pnpm.', spec: proposed, unfinished: [] },
  buildingBlock: null,
  read: ['/', 'package.json'],
  ...overrides,
});

describe('asking', () => {
  it('sends nothing until the box says something, and nothing while an answer is coming', () => {
    expect(canAsk(initialAssistant)).toBe(false);
    const typed = run([{ type: 'draft', text: '  ' }]);
    expect(canAsk(typed)).toBe(false);
    const asked = run([
      { type: 'draft', text: 'Build with pnpm' },
      { type: 'asked', id: 'q1', text: 'Build with pnpm' },
    ]);
    expect(asked.draft).toBe('');
    expect(asked.busy).toBe(true);
    expect(canAsk(run([{ type: 'draft', text: 'more' }], asked))).toBe(false);
    // A second question while busy is not taken.
    expect(run([{ type: 'asked', id: 'q2', text: 'more' }], asked).messages).toHaveLength(1);
  });

  it('a question from a button keeps what the person was typing', () => {
    const state = run([
      { type: 'draft', text: 'half a thought' },
      {
        type: 'asked',
        id: 'q1',
        text: reuseQuestion({ key: 'build-billing', name: 'Build billing' }),
      },
    ]);
    expect(state.draft).toBe('half a thought');
    expect(state.messages[0].text).toBe(
      'Turn the project’s block “Build billing” (build-billing) into a building block other projects can reuse.'
    );
  });

  it('a refusal lists what it named, and the next question clears it', () => {
    const refused = run([
      { type: 'asked', id: 'q1', text: 'Fix it' },
      { type: 'failed', error: 'The conversation is too long.', problems: ['Start a new one.'] },
    ]);
    expect(refused.problems).toEqual(['Start a new one.']);
    expect(run([{ type: 'asked', id: 'q2', text: 'Again' }], refused).problems).toEqual([]);
  });

  it('is worked out in the background: the job’s steps show, then its answer', () => {
    const started = run([
      { type: 'asked', id: 'q1', text: 'Build with pnpm' },
      { type: 'started', job: 'job-1' },
      { type: 'progressed', job: 'job-1', step: 'Reading package.json' },
    ]);
    expect(started).toMatchObject({ busy: true, job: 'job-1', step: 'Reading package.json' });
    // Another job's steps are not this one's.
    expect(run([{ type: 'progressed', job: 'job-0', step: 'x' }], started).step).toBe(
      'Reading package.json'
    );
    const done = run([{ type: 'answered', id: 'a1', job: 'job-1', answer: answer() }], started);
    expect(done).toMatchObject({ busy: false, job: null, step: null });
    expect(done.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('an answer to a question given up on (a new conversation) is dropped', () => {
    const abandoned = run([
      { type: 'asked', id: 'q1', text: 'Build with pnpm' },
      { type: 'started', job: 'job-1' },
      { type: 'reset' },
    ]);
    expect(
      run([{ type: 'answered', id: 'a1', job: 'job-1', answer: answer() }], abandoned)
    ).toEqual(initialAssistant);
    expect(
      run([{ type: 'failed', job: 'job-1', error: 'interrupted' }], abandoned).error
    ).toBeNull();
    // A new question's job is followed instead.
    const next = run(
      [
        { type: 'asked', id: 'q2', text: 'Again' },
        { type: 'started', job: 'job-2' },
        { type: 'answered', id: 'a1', job: 'job-1', answer: answer() },
      ],
      abandoned
    );
    expect(next).toMatchObject({ busy: true, job: 'job-2' });
  });

  it('a failed question leaves the thread, goes back in the box, and says why', () => {
    const state = run([
      { type: 'draft', text: 'Build with pnpm' },
      { type: 'asked', id: 'q1', text: 'Build with pnpm' },
      { type: 'failed', error: 'The model did not answer in time; try again.' },
    ]);
    expect(state.messages).toEqual([]);
    expect(state.draft).toBe('Build with pnpm');
    expect(state.error).toBe('The model did not answer in time; try again.');
    expect(canAsk(state)).toBe(true);
  });

  it('sends the conversation in words, with each proposal and whether it was applied, and the pipeline on screen', () => {
    const state = run([
      { type: 'asked', id: 'q1', text: 'Build with pnpm' },
      { type: 'answered', id: 'a1', answer: answer() },
      { type: 'applied', id: 'a1' },
      { type: 'asked', id: 'q2', text: 'Now deploy it' },
    ]);
    expect(askRequest(state, proposed)).toEqual({
      conversation: [
        { role: 'user', text: 'Build with pnpm' },
        {
          role: 'assistant',
          text: 'I read package.json; it builds with pnpm.\n\n(I proposed: Builds with pnpm. The person applied it.)',
        },
        { role: 'user', text: 'Now deploy it' },
      ],
      spec: proposed,
    });
  });
});

describe('a proposal', () => {
  it('shows each row, the blocks it writes for the project, and what is still to do', () => {
    const state = run([
      { type: 'asked', id: 'q1', text: 'Build with pnpm' },
      {
        type: 'answered',
        id: 'a1',
        answer: answer({
          proposal: {
            summary: 'Builds with pnpm.',
            spec: proposed,
            unfinished: ['production, step 1: Fill in “service_name”.'],
          },
        }),
      },
    ]);
    const card = proposalCard(state, state.messages[1], current, (key) =>
      key === 'node-test' ? 'Node: test' : key
    );
    expect(card).toEqual({
      summary: 'Builds with pnpm.',
      rows: ['Pull requests: Node: test → Build billing', 'production (on merge to main): nothing'],
      ownBlocks: [
        {
          key: 'build-billing',
          name: 'Build billing',
          description: 'pnpm, as the repository builds.',
          isNew: true,
        },
      ],
      unfinished: ['production, step 1: Fill in “service_name”.'],
      applied: false,
    });
    // Once applied it says so, and a block already on screen as proposed is not listed again.
    const applied = run([{ type: 'applied', id: 'a1' }], state);
    expect(proposalCard(applied, applied.messages[1], proposed, (k) => k)).toMatchObject({
      applied: true,
      ownBlocks: [],
    });
  });

  it('an answer without one shows none', () => {
    const state = run([
      { type: 'asked', id: 'q1', text: 'What does it run?' },
      { type: 'answered', id: 'a1', answer: answer({ proposal: null }) },
    ]);
    expect(proposalCard(state, state.messages[1], current, (k) => k)).toBeNull();
  });
});

describe('a building block for every project (operators)', () => {
  const general = {
    key: 'node-pnpm-build',
    name: 'Node: build with pnpm',
    description: 'Installs with pnpm and runs a script.',
    kind: 'build' as const,
    definition: { ...build, inputs: [{ name: 'script', type: 'text' as const, default: 'build' }] },
    from: 'build-billing',
  };
  const answered = run([
    { type: 'asked', id: 'q1', text: 'Make it reusable' },
    { type: 'answered', id: 'a1', answer: answer({ proposal: null, buildingBlock: general }) },
  ]);

  it('saves as the catalogue’s own create body', () => {
    expect(buildingBlockRequest(answered, 'a1')).toEqual({
      key: 'node-pnpm-build',
      name: 'Node: build with pnpm',
      description: 'Installs with pnpm and runs a script.',
      kind: 'build',
      definition: general.definition,
    });
    expect(buildingBlockRequest(answered, 'q1')).toBeNull();
  });

  it('a refused save says why and can be tried again; a saved one remembers its draft', () => {
    const refused = run(
      [
        { type: 'savingBlock', id: 'a1' },
        { type: 'blockFailed', id: 'a1', error: 'A block with the key “node-pnpm-build” exists.' },
      ],
      answered
    );
    expect(refused.saving).toBeNull();
    expect(refused.blockErrors).toEqual({ a1: 'A block with the key “node-pnpm-build” exists.' });
    const saved = run(
      [
        { type: 'savingBlock', id: 'a1' },
        { type: 'blockSaved', id: 'a1', blockId: 'blk-1' },
      ],
      refused
    );
    expect(saved.blockErrors).toEqual({});
    expect(saved.saved).toEqual({ a1: 'blk-1' });
    expect(askRequest(saved, current).conversation[1].text).toContain(
      '(I proposed the building block node-pnpm-build; it was saved as a draft.)'
    );
  });

  it('a new conversation starts empty', () => {
    expect(run([{ type: 'reset' }], answered)).toEqual(initialAssistant);
  });
});

describe('a pipeline written by hand: the conversation is about its file', () => {
  const CI = 'name: CI\non: [push]\njobs: {}\n';
  const edited = 'name: CI\non: [push, pull_request]\njobs: {}\n';
  const asked = run([
    { type: 'draft', text: 'Run it on pull requests too.' },
    { type: 'asked', id: 'q1', text: 'Run it on pull requests too.' },
    { type: 'started', job: 'job-1' },
  ]);
  const answered = run(
    [
      {
        type: 'answered',
        id: 'a1',
        job: 'job-1',
        answer: answer({
          reply: 'It now runs on pull requests as well.',
          proposal: null,
          file: { summary: 'Adds the pull_request trigger.', name: 'ci.yml', text: edited },
        }),
      },
    ],
    asked
  );

  it('an answer’s edited file stays with the answer', () => {
    expect(answered.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'It now runs on pull requests as well.',
      file: { summary: 'Adds the pull_request trigger.', name: 'ci.yml', text: edited },
    });
    // An answer in words alone carries none.
    const words = run(
      [{ type: 'answered', id: 'a1', job: 'job-1', answer: answer({ proposal: null }) }],
      asked
    );
    expect(words.messages[1]).not.toHaveProperty('file');
    expect(fileCard(words, words.messages[1])).toBeNull();
  });

  it('shows as the file’s name, its size and what changed, until it is put in the editor', () => {
    expect(fileCard(answered, answered.messages[1])).toEqual({
      summary: 'Adds the pull_request trigger.',
      name: 'ci.yml',
      size: '3 lines',
      applied: false,
    });
    const applied = run([{ type: 'applied', id: 'a1' }], answered);
    expect(fileCard(applied, applied.messages[1])?.applied).toBe(true);
    // The person's own turn has no file.
    expect(fileCard(answered, answered.messages[0])).toBeNull();
  });

  it('a one-line file reads as one line', () => {
    const one = run(
      [
        {
          type: 'answered',
          id: 'a1',
          job: 'job-1',
          answer: answer({
            proposal: null,
            file: { summary: 'x', name: 'ci.yml', text: 'name: CI\n' },
          }),
        },
      ],
      asked
    );
    expect(fileCard(one, one.messages[1])?.size).toBe('1 line');
  });

  it('a question sends the conversation and the file as the editor has it, not a pipeline of blocks', () => {
    const sent = askFileRequest(asked, { name: 'ci.yml', text: CI });
    expect(sent).toEqual({
      conversation: [{ role: 'user', text: 'Run it on pull requests too.' }],
      file: { name: 'ci.yml', text: CI },
    });
    expect(sent).not.toHaveProperty('spec');
  });

  it('the next question says whether the last file was put in the editor', () => {
    const before = askFileRequest(answered, { name: 'ci.yml', text: CI });
    expect(before.conversation[1].text).toBe(
      'It now runs on pull requests as well.\n\n(I proposed an edit to ci.yml: Adds the pull_request trigger. The person has not put it in the editor.)'
    );
    const applied = run([{ type: 'applied', id: 'a1' }], answered);
    const after = askFileRequest(applied, { name: 'ci.yml', text: edited });
    expect(after.conversation[1].text).toContain('The person put it in the editor.)');
    // And the file it is asked about is the one now in the editor.
    expect(after.file.text).toBe(edited);
  });
});
