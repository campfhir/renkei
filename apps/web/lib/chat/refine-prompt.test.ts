/**
 * Refining a library prompt: what the model is sent, how its reply becomes a
 * proposal, and the pass that asks once more when the proposal's variables do
 * not read cleanly. The route that asks for one is tested beside it
 * (app/api/chat/prompt-libraries/[libraryId]/prompts/refine/route.test.ts).
 */

jest.mock('@renkei/agent-llm', () => ({
  ...jest.requireActual('@renkei/agent-llm'),
  resolveAgentLlm: jest.fn(),
}));
jest.mock('@renkei/agents/runs', () => ({
  ...jest.requireActual('@renkei/agents/runs'),
  recordLlmCall: jest.fn(),
}));

import {
  REFINE_PROMPT_SYSTEM_PROMPT,
  REFINE_PROMPT_TOOL,
  buildRefinePromptMessage,
  parseRefinePromptReply,
  proposalProblems,
  refinePrompt,
  type RefinePromptInput,
} from './refine-prompt';

const { resolveAgentLlm: mockResolve } = jest.requireMock<{ resolveAgentLlm: jest.Mock }>(
  '@renkei/agent-llm'
);
const { recordLlmCall: mockRecord } = jest.requireMock<{ recordLlmCall: jest.Mock }>(
  '@renkei/agents/runs'
);

const INPUT: RefinePromptInput = {
  libraryName: 'Development',
  libraryDescription: 'Prompts for working in a repository',
  scope: 'code',
  title: 'Review a file',
  body: 'review the file for bugs',
  guidance: null,
};

describe('what the model is sent', () => {
  it('names the library, where it is offered, the title and the draft', () => {
    const text = buildRefinePromptMessage({ ...INPUT, guidance: '  ask which file  ' });
    expect(text).toContain('Library: Development');
    expect(text).toContain('Description: Prompts for working in a repository');
    expect(text).toContain('code projects only');
    expect(text).toContain('Title: Review a file');
    expect(text).toContain('<draft>\nreview the file for bugs\n</draft>');
    expect(text).toContain('What the editor wants changed:\nask which file');
  });

  it('says every chat for an ordinary library, and leaves out what is not there', () => {
    const text = buildRefinePromptMessage({
      ...INPUT,
      scope: 'any',
      libraryDescription: null,
      guidance: '   ',
    });
    expect(text).toContain('Offered in: every chat.');
    expect(text).not.toContain('Description:');
    expect(text).not.toContain('wants changed');
  });

  it('with no draft, asks for a prompt written from what the editor describes', () => {
    const text = buildRefinePromptMessage({
      ...INPUT,
      title: '',
      body: '  ',
      guidance: 'a prompt that plans a database migration',
    });
    expect(text).toContain('Title: (none yet)');
    expect(text).not.toContain('<draft>');
    expect(text).toContain('There is no draft yet');
    expect(text).toContain('What the prompt is for:\na prompt that plans a database migration');
  });

  it('on a second go, carries the earlier attempt and each problem', () => {
    const text = buildRefinePromptMessage(INPUT, {
      previous: 'Pick {{c:choice}}',
      problems: ['"c" is a choice but lists no options, asking for text instead.'],
    });
    expect(text).toContain('<previous>\nPick {{c:choice}}\n</previous>');
    expect(text).toContain('- "c" is a choice but lists no options');
    expect(text).toContain('Fix them and propose the prompt again.');
  });
});

describe('what the model is told about prompts', () => {
  it('teaches the placeholder syntax, the types, the block and the limits', () => {
    expect(REFINE_PROMPT_SYSTEM_PROMPT).toContain('{{name:type}}');
    for (const type of ['text', 'longtext', 'number', 'date', 'choice', 'multi']) {
      expect(REFINE_PROMPT_SYSTEM_PROMPT).toContain(type);
    }
    expect(REFINE_PROMPT_SYSTEM_PROMPT).toContain('```variables');
    expect(REFINE_PROMPT_SYSTEM_PROMPT).toContain('required');
    expect(REFINE_PROMPT_SYSTEM_PROMPT).toContain('At most 10 variables');
    expect(REFINE_PROMPT_SYSTEM_PROMPT).toContain('at most 25');
  });

  it('says how the variables are used: the form and the assistant asking', () => {
    expect(REFINE_PROMPT_SYSTEM_PROMPT).toContain('opens a form');
    expect(REFINE_PROMPT_SYSTEM_PROMPT).toContain('form in the chat');
  });
});

describe('the reply', () => {
  it('is the tool’s prompt, trimmed, with its suggested title', () => {
    expect(
      parseRefinePromptReply([
        {
          type: 'tool_use',
          name: REFINE_PROMPT_TOOL,
          input: { body: '  Review {{file}}.  ', title: '  Review a file ' },
        },
      ])
    ).toEqual({ body: 'Review {{file}}.', title: 'Review a file' });
  });

  it('has no title when the model gave none', () => {
    expect(
      parseRefinePromptReply([
        { type: 'tool_use', name: REFINE_PROMPT_TOOL, input: { body: 'Do it.' } },
      ])
    ).toEqual({ body: 'Do it.', title: null });
  });

  it('is the text when the model answered without the tool', () => {
    expect(parseRefinePromptReply([{ type: 'text', text: ' Do it. ' }])).toEqual({
      body: 'Do it.',
      title: null,
    });
  });

  it('is nothing when the tool came back empty, or nothing came back', () => {
    expect(
      parseRefinePromptReply([{ type: 'tool_use', name: REFINE_PROMPT_TOOL, input: { body: ' ' } }])
    ).toBeNull();
    expect(parseRefinePromptReply([])).toBeNull();
  });

  it('keeps a long prompt within what a prompt may be', () => {
    const reply = parseRefinePromptReply([
      { type: 'tool_use', name: REFINE_PROMPT_TOOL, input: { body: 'x'.repeat(30_000) } },
    ]);
    expect(reply?.body).toHaveLength(20_000);
  });
});

describe('a proposal’s problems', () => {
  it('are the parser’s: none for a clean prompt, named for a choice with no options', () => {
    expect(proposalProblems({ body: 'Review {{file}}.', title: null })).toEqual([]);
    expect(proposalProblems({ body: 'Pick {{c:choice}}', title: null })).toEqual([
      '"c" is a choice but lists no options, asking for text instead.',
    ]);
  });
});

describe('the pass', () => {
  const complete = jest.fn();
  const answer = (body: string, title?: string) => ({
    ok: true,
    val: {
      content: [
        {
          type: 'tool_use',
          id: 't',
          name: REFINE_PROMPT_TOOL,
          input: { body, ...(title ? { title } : {}) },
        },
      ],
      usage: { inputTokens: 100, outputTokens: 20 },
    },
  });
  const CLEAN = 'Review {{file}} for bugs.\n\n```variables\nfile:\n  required: true\n```';
  const BROKEN = 'Review {{file}} for {{focus:choice}}.';

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockResolvedValue({
      ok: true,
      val: {
        provider: { complete },
        providerName: 'openai',
        model: 'stub-model',
        modelConfigId: null,
        maxOutputTokens: 4_096,
      },
    });
  });

  it('asks once when the first proposal reads cleanly, and records that one call', async () => {
    complete.mockResolvedValueOnce(answer(CLEAN, 'Review a file'));
    const outcome = await refinePrompt('alice', INPUT, null);
    expect(outcome).toEqual({ ok: true, proposal: { body: CLEAN, title: 'Review a file' } });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].toolChoice).toEqual({ name: REFINE_PROMPT_TOOL });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'alice', purpose: 'prompt_refine', inputTokens: 100 })
    );
    expect(mockResolve).toHaveBeenCalledWith(null);
  });

  it('asks again with the problems when the first has some, and takes the cleaner answer', async () => {
    complete.mockResolvedValueOnce(answer(BROKEN)).mockResolvedValueOnce(answer(CLEAN));
    const outcome = await refinePrompt('alice', INPUT, 'model-1');
    expect(outcome).toEqual({ ok: true, proposal: { body: CLEAN, title: null } });
    expect(complete).toHaveBeenCalledTimes(2);
    const second = complete.mock.calls[1][0].messages[0].content[0].text;
    expect(second).toContain('<previous>\nReview {{file}} for {{focus:choice}}.\n</previous>');
    expect(second).toContain('"focus" is a choice but lists no options');
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockResolve).toHaveBeenCalledWith('model-1');
  });

  it('keeps the first answer when the second has more problems', async () => {
    const worse = 'Review {{a:choice}} and {{b:choice}}.';
    complete.mockResolvedValueOnce(answer(BROKEN)).mockResolvedValueOnce(answer(worse));
    const outcome = await refinePrompt('alice', INPUT, null);
    expect(outcome).toEqual({ ok: true, proposal: { body: BROKEN, title: null } });
  });

  it('keeps the first answer when the second go fails', async () => {
    complete
      .mockResolvedValueOnce(answer(BROKEN))
      .mockResolvedValueOnce({ ok: false, err: { type: 'server', message: 'boom' } });
    const outcome = await refinePrompt('alice', INPUT, null);
    expect(outcome).toEqual({ ok: true, proposal: { body: BROKEN, title: null } });
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('says so when the first call fails, and records nothing', async () => {
    complete.mockResolvedValueOnce({ ok: false, err: { type: 'server', message: 'boom' } });
    const outcome = await refinePrompt('alice', INPUT, null);
    expect(outcome).toMatchObject({ ok: false, status: 502, code: 'model-failed' });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('points an operator at the model settings when the credentials are refused', async () => {
    complete.mockResolvedValueOnce({ ok: false, err: { type: 'auth', message: 'no' } });
    const outcome = await refinePrompt('alice', INPUT, null);
    expect(outcome.ok === false && outcome.error).toMatch(/Agent models/);
  });

  it('says so when the reply cannot be read', async () => {
    complete.mockResolvedValueOnce({
      ok: true,
      val: { content: [], usage: { inputTokens: 1, outputTokens: 0 } },
    });
    const outcome = await refinePrompt('alice', INPUT, null);
    expect(outcome).toMatchObject({ ok: false, status: 502, code: 'unreadable' });
  });

  it('says so when the organization has no model', async () => {
    mockResolve.mockResolvedValue({ ok: false });
    const outcome = await refinePrompt('alice', INPUT, null);
    expect(outcome).toMatchObject({ ok: false, status: 503, code: 'no-model' });
    expect(complete).not.toHaveBeenCalled();
  });
});
