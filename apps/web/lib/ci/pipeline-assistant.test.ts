/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The pipeline builder's assistant: it reads the repository before it
 * proposes; a proposal that does not read goes back to the model with
 * what is wrong; a usable one comes back with the blocks it wrote for the
 * project; only an operator is offered — and can make — a building block
 * for every project; a conversation as sent ends on the person's word.
 */

import type { BlockDefinition, PipelineBlock } from '@renkei/ci-blocks';
import {
  MAX_ROUNDS,
  UNFINISHED,
  cleanPath,
  gaveUp,
  readConversation,
  runPipelineAssistant,
  type AssistantDeps,
  type AssistantInput,
} from './pipeline-assistant';

const nodeTest: BlockDefinition = {
  kind: 'test',
  runsOn: { type: 'hosted', image: 'node:22' },
  inputs: [],
  variables: [],
  consumes: [],
  produces: [],
  caches: [],
  commands: 'npm ci && npm test',
};
const blocks: (PipelineBlock & { description: string | null })[] = [
  { key: 'node-test', name: 'Node: test', version: 1, definition: nodeTest, description: null },
];

const ownBuild = {
  key: 'build-billing',
  name: 'Build billing',
  version: 1,
  definition: {
    kind: 'build',
    runsOn: { type: 'hosted', image: 'node:20' },
    inputs: [],
    variables: [],
    consumes: [],
    produces: [{ name: 'dist', paths: ['dist'] }],
    caches: [],
    commands: 'pnpm install --frozen-lockfile\npnpm build',
  },
};

const input = (overrides: Partial<AssistantInput> = {}): AssistantInput => ({
  conversation: [{ role: 'user', text: 'Tailor the pipeline to this repository.' }],
  spec: { checks: [{ block: 'node-test', version: 1, inputs: {} }], environments: [] },
  host: 'bitbucket',
  repo: 'acme/billing',
  branch: 'main',
  blocks,
  targets: [],
  operator: false,
  ...overrides,
});

type Step = {
  text?: string;
  calls?: { name: string; input: unknown }[];
  stop?: 'end_turn' | 'tool_use' | 'max_tokens';
};
function model(steps: Step[]) {
  const complete = jest.fn();
  steps.forEach((step, n) => {
    complete.mockResolvedValueOnce({
      ok: true,
      val: {
        content: [
          ...(step.text ? [{ type: 'text', text: step.text }] : []),
          ...(step.calls ?? []).map((call, i) => ({
            type: 'tool_use',
            id: `call-${n}-${i}`,
            name: call.name,
            input: call.input,
          })),
        ],
        stopReason: step.stop ?? (step.calls ? 'tool_use' : 'end_turn'),
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
  });
  return complete;
}

function deps(complete: jest.Mock): AssistantDeps {
  return {
    complete,
    maxOutputTokens: 4000,
    listFiles: jest.fn(async () => ({
      ok: true as const,
      entries: [
        { path: 'src', kind: 'dir' as const },
        { path: 'package.json', kind: 'file' as const },
      ],
    })),
    readFile: jest.fn(async (path: string) =>
      path === 'package.json'
        ? {
            ok: true as const,
            text: '{"scripts":{"build":"tsc"}}',
            truncated: false,
            binary: false,
          }
        : { ok: false as const, error: 'Not found.' }
    ),
  };
}

/** What the model was sent back for each call, in order. */
function results(complete: jest.Mock): { content: string; isError?: boolean }[] {
  const last = complete.mock.calls[complete.mock.calls.length - 1][0];
  return last.messages.flatMap(
    (m: { content: { type: string; content?: string; isError?: boolean }[] }) =>
      m.content
        .filter((c) => c.type === 'tool_result')
        .map((c) => ({ content: c.content ?? '', ...(c.isError ? { isError: true } : {}) }))
  );
}

it('reads the repository, then proposes the pipeline with a block of the project’s own', async () => {
  const proposal = {
    summary: 'Builds with pnpm, as the repository does.',
    checks: [
      { block: 'node-test', version: 1, inputs: {} },
      { block: 'build-billing', version: 1, inputs: {} },
    ],
    environments: [],
    blocks: [ownBuild],
  };
  const complete = model([
    { calls: [{ name: 'list_files', input: {} }] },
    { calls: [{ name: 'read_file', input: { path: 'package.json' } }] },
    { text: 'I read package.json.', calls: [{ name: 'propose_pipeline', input: proposal }] },
    { text: 'Apply it to build with pnpm.' },
  ]);
  const d = deps(complete);
  const reply = await runPipelineAssistant(input(), d);
  expect(reply).toEqual({
    reply: 'Apply it to build with pnpm.',
    proposal: {
      summary: 'Builds with pnpm, as the repository does.',
      spec: { checks: proposal.checks, environments: [], blocks: [ownBuild] },
      unfinished: [],
    },
    buildingBlock: null,
    read: ['/', 'package.json'],
  });
  expect(results(complete).map((r) => r.content)).toEqual([
    'src/\npackage.json',
    '{"scripts":{"build":"tsc"}}',
    'Proposed. The person reviews it; the file can be written as it is.',
  ]);
  // It sees the pipeline as the builder has it, and the organization's blocks.
  const system: string = complete.mock.calls[0][0].system;
  expect(system).toContain('"block":"node-test"');
  expect(system).toContain('- node-test v1 — Node: test (test, image node:22)');
  expect(complete.mock.calls[0][0].tools.map((t: { name: string }) => t.name)).toEqual([
    'list_files',
    'read_file',
    'propose_pipeline',
  ]);
});

it('sends a proposal that does not read back with what is wrong, and takes the corrected one', async () => {
  const complete = model([
    {
      calls: [
        {
          name: 'propose_pipeline',
          input: {
            summary: 'x',
            checks: [{ block: 'nope', version: 1, inputs: {} }],
            environments: [],
            blocks: [{ ...ownBuild, key: 'unused' }],
          },
        },
      ],
    },
    {
      calls: [
        {
          name: 'propose_pipeline',
          input: {
            summary: 'Fixed.',
            checks: [{ block: 'node-test', version: 1 }],
            environments: [],
          },
        },
      ],
    },
    { text: 'Done.' },
  ]);
  const reply = await runPipelineAssistant(input(), deps(complete));
  expect(results(complete)[0]).toEqual({
    content:
      'The pipeline cannot be used yet:\n' +
      '- Pull requests, step 1: there is no block nope; use an organization block or add one to "blocks".\n' +
      '- The block unused is not used by any step; use it or leave it out.\n' +
      'Call propose_pipeline again with the whole corrected pipeline.',
    isError: true,
  });
  expect(reply).toMatchObject({ proposal: { summary: 'Fixed.' } });
});

it('sends a proposal cut off at the output limit back to be sent again, instead of answering with its preamble', async () => {
  const whole = {
    summary: 'Passes the variables to the runners.',
    checks: [{ block: 'node-test', version: 1, inputs: {} }],
    environments: [],
  };
  const complete = model([
    {
      text: 'Next I’ll propose the pipeline change.',
      calls: [{ name: 'propose_pipeline', input: { summary: 'Passes' } }],
      stop: 'max_tokens',
    },
    { calls: [{ name: 'propose_pipeline', input: whole }] },
    { text: 'Apply it, then set the variables.' },
  ]);
  const reply = await runPipelineAssistant(input(), deps(complete));
  expect(results(complete)[0]).toEqual({
    content:
      'Your reply reached the output limit before this call was complete, so it was not used. Send it again, whole and more compact: short descriptions, no repeated text.',
    isError: true,
  });
  expect(reply).toMatchObject({
    reply: 'Apply it, then set the variables.',
    proposal: { summary: 'Passes the variables to the runners.' },
  });
});

it('keeps going as long as it takes, reading until its budget is spent, then answers', async () => {
  // 41 rounds of listing — far past any round limit — then the answer.
  const steps: Step[] = [
    ...Array.from({ length: 41 }, () => ({
      text: 'Next I’ll look further.',
      calls: [{ name: 'list_files', input: {} }],
    })),
    {
      calls: [
        { name: 'propose_pipeline', input: { summary: 'Done.', checks: [], environments: [] } },
      ],
    },
    { text: 'Apply it.' },
  ];
  const complete = model(steps);
  const d = deps(complete);
  const reply = await runPipelineAssistant(input(), d);
  expect(reply).toMatchObject({ reply: 'Apply it.', proposal: { summary: 'Done.' } });
  // The 41st listing is past the budget: refused, so it proposes.
  expect(d.listFiles).toHaveBeenCalledTimes(40);
  expect(results(complete)[40]).toEqual({
    content: 'That is 40 directories already; propose from what you have seen.',
    isError: true,
  });
});

it('gives up after three proposals that do not read, saying what was wrong with the last', async () => {
  const bad = (n: number) => ({
    calls: [
      {
        name: 'propose_pipeline',
        input: { summary: 'x', checks: [{ block: `nope-${n}`, version: 1 }], environments: [] },
      },
    ],
  });
  const complete = model([bad(1), bad(2), bad(3), { text: 'never asked' }]);
  const reply = await runPipelineAssistant(input(), deps(complete));
  expect(complete).toHaveBeenCalledTimes(3);
  expect(reply).toMatchObject({
    proposal: null,
    reply: gaveUp(
      [
        'Pull requests, step 1: there is no block nope-3; use an organization block or add one to "blocks".',
      ],
      false
    ),
  });
});

it('counts a proposal cut off at the reply limit as a failed one, and keeps one that read', async () => {
  const good = {
    name: 'propose_pipeline',
    input: { summary: 'Good.', checks: [], environments: [] },
  };
  const cut = { calls: [{ name: 'propose_pipeline', input: {} }], stop: 'max_tokens' as const };
  const complete = model([{ calls: [good] }, cut, cut, cut, { text: 'never asked' }]);
  const reply = await runPipelineAssistant(input(), deps(complete));
  expect(complete).toHaveBeenCalledTimes(4);
  expect(reply).toMatchObject({
    proposal: { summary: 'Good.' },
    reply: gaveUp(['It was cut off at the model’s reply limit before it was complete.'], true),
  });
});

it('stops at the backstop of rounds and says it did not finish', async () => {
  const complete: jest.Mock = jest.fn(async () => ({
    ok: true,
    val: {
      content: [{ type: 'tool_use', id: 'c', name: 'no_such_tool', input: {} }],
      stopReason: 'tool_use',
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  }));
  const reply = await runPipelineAssistant(input(), deps(complete));
  expect(complete).toHaveBeenCalledTimes(MAX_ROUNDS);
  expect(reply).toMatchObject({ reply: UNFINISHED, proposal: null });
});

it('says it did not finish when its reply was cut off with nothing in it', async () => {
  const complete = model([{ stop: 'max_tokens' }]);
  const reply = await runPipelineAssistant(input(), deps(complete));
  expect(reply).toMatchObject({ reply: UNFINISHED, proposal: null });
});

it('refuses a path out of the repository, and stops reading after its limit', async () => {
  expect(cleanPath('../etc/passwd')).toBeNull();
  expect(cleanPath('./src/')).toBe('src');
  const complete = model([
    { calls: [{ name: 'read_file', input: { path: '../secrets' } }] },
    { text: 'I could not read that.' },
  ]);
  const d = deps(complete);
  await runPipelineAssistant(input(), d);
  expect(d.readFile).not.toHaveBeenCalled();
  expect(results(complete)[0]).toEqual({
    content: 'Name a file in the repository.',
    isError: true,
  });
});

it('offers an operator a building block for every project, and refuses a key the catalogue has', async () => {
  const general = {
    from: 'build-billing',
    key: 'node-pnpm-build',
    name: 'Node: build with pnpm',
    description: 'Installs with pnpm and runs a build script.',
    definition: {
      ...ownBuild.definition,
      inputs: [{ name: 'script', type: 'text', default: 'build' }],
      commands: 'pnpm install --frozen-lockfile\npnpm ${input.script}',
    },
  };
  const complete = model([
    { calls: [{ name: 'propose_building_block', input: { ...general, key: 'node-test' } }] },
    { calls: [{ name: 'propose_building_block', input: general }] },
    { text: 'Save it as a draft to review.' },
  ]);
  const reply = await runPipelineAssistant(input({ operator: true }), deps(complete));
  expect(complete.mock.calls[0][0].tools.map((t: { name: string }) => t.name)).toContain(
    'propose_building_block'
  );
  expect(results(complete)[0].content).toContain(
    'The organization has a block keyed node-test; choose another key.'
  );
  expect(reply).toMatchObject({
    buildingBlock: {
      key: 'node-pnpm-build',
      kind: 'build',
      from: 'build-billing',
      definition: { inputs: [{ name: 'script', type: 'text', default: 'build' }] },
    },
  });
});

it('does not let a person who is not an operator make a building block', async () => {
  const complete = model([
    { calls: [{ name: 'propose_building_block', input: { key: 'x-block', name: 'X' } }] },
    { text: 'Only operators can.' },
  ]);
  const reply = await runPipelineAssistant(input(), deps(complete));
  expect(complete.mock.calls[0][0].tools.map((t: { name: string }) => t.name)).not.toContain(
    'propose_building_block'
  );
  expect(results(complete)[0]).toEqual({
    content: 'There is no tool propose_building_block.',
    isError: true,
  });
  expect(reply).toMatchObject({ buildingBlock: null });
});

it('works from a pipeline that does not read yet, told what is wrong with it', async () => {
  const complete = model([{ text: 'Production needs a branch; I set it to main.' }]);
  const broken = { checks: [], environments: [{ name: 'production', branch: '', steps: [] }] };
  await runPipelineAssistant(
    input({
      spec: broken,
      specProblems: ['production needs the branch whose merges deploy it.'],
    }),
    deps(complete)
  );
  const system: string = complete.mock.calls[0][0].system;
  expect(system).toContain(JSON.stringify(broken));
  expect(system).toContain(
    'It does not read yet, so it cannot be saved:\n- production needs the branch whose merges deploy it.'
  );
});

it('says what the model’s failure means', async () => {
  const complete = jest.fn().mockResolvedValue({ ok: false, err: { type: 'rate_limit' } } as never);
  expect(await runPipelineAssistant(input(), deps(complete))).toEqual({
    error: 'The model is rate-limiting right now; try again in a minute.',
  });
});

it('reads a conversation as sent: trimmed, starting and ending on the person', () => {
  expect(
    readConversation([
      { role: 'assistant', text: 'Hello' },
      { role: 'user', text: '  Use pnpm  ' },
      { role: 'system', text: 'ignored' },
    ])
  ).toEqual([{ role: 'user', text: 'Use pnpm' }]);
  expect(
    readConversation([
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
    ])
  ).toEqual({ error: 'Say what you would like the assistant to do.' });
  expect(readConversation('nope')).toEqual({ error: 'Send the conversation.' });
});
