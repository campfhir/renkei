import { buildHistory, buildSystemPrompt } from './request-builder';
import type { StoredMessage } from './messages';

function row(
  partial: Partial<StoredMessage> & Pick<StoredMessage, 'seq' | 'role' | 'blocks'>
): StoredMessage {
  return {
    id: `m${partial.seq}`,
    chatId: 'c',
    turnId: 'old',
    kind: partial.role === 'assistant' ? 'assistant' : 'prompt',
    status: 'complete',
    llmModelId: 'model-1',
    provider: 'anthropic',
    model: 'x',
    stopReason: null,
    usage: null,
    error: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...partial,
  };
}

const target = { turnId: 'now', llmModelId: 'model-1', providerName: 'anthropic' };

describe('buildHistory', () => {
  it('strips thinking from earlier turns and keeps it within the current one', () => {
    const history = buildHistory(
      [
        row({ seq: 1, role: 'user', blocks: [{ type: 'text', text: 'hi' }] }),
        row({
          seq: 2,
          role: 'assistant',
          blocks: [
            { type: 'thinking', thinking: 'old', signature: 's' },
            { type: 'text', text: 'hello' },
          ],
        }),
        row({ seq: 3, role: 'user', turnId: 'now', blocks: [{ type: 'text', text: 'more' }] }),
        row({
          seq: 4,
          role: 'assistant',
          turnId: 'now',
          blocks: [
            { type: 'thinking', thinking: 'new', signature: 's2' },
            { type: 'tool_use', id: 't1', name: 'x', input: {} },
          ],
        }),
        row({
          seq: 5,
          role: 'user',
          turnId: 'now',
          kind: 'tool_results',
          blocks: [{ type: 'tool_result', toolUseId: 't1', content: 'r' }],
        }),
        row({ seq: 6, role: 'assistant', turnId: 'now', status: 'streaming', blocks: [] }),
      ],
      target,
      'm6'
    );
    expect(history).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'more' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'new', signature: 's2' },
          { type: 'tool_use', id: 't1', name: 'x', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'r' }] },
    ]);
  });

  it('strips thinking after a model switch and on non-Anthropic providers', () => {
    const rows = [
      row({ seq: 1, role: 'user', turnId: 'now', blocks: [{ type: 'text', text: 'hi' }] }),
      row({
        seq: 2,
        role: 'assistant',
        turnId: 'now',
        llmModelId: 'model-2',
        blocks: [
          { type: 'thinking', thinking: 'x', signature: 's' },
          { type: 'text', text: 'a' },
        ],
      }),
    ];
    expect(buildHistory(rows, target, null)[1].content).toEqual([{ type: 'text', text: 'a' }]);
    expect(
      buildHistory(
        rows.map((r) => ({ ...r, llmModelId: 'model-1' })),
        { ...target, providerName: 'openai' },
        null
      )[1].content
    ).toEqual([{ type: 'text', text: 'a' }]);
  });

  it('drops a dangling tool_use, an orphan tool_result, empty blocks and failed rows', () => {
    const history = buildHistory(
      [
        row({ seq: 1, role: 'user', blocks: [{ type: 'text', text: 'hi' }] }),
        row({
          seq: 2,
          role: 'assistant',
          status: 'interrupted',
          blocks: [
            { type: 'text', text: 'calling' },
            { type: 'tool_use', id: 'lost', name: 'x', input: {} },
          ],
        }),
        row({ seq: 3, role: 'user', blocks: [{ type: 'text', text: '  ' }] }),
        row({
          seq: 4,
          role: 'assistant',
          status: 'failed',
          blocks: [{ type: 'text', text: 'nope' }],
        }),
        row({
          seq: 5,
          role: 'user',
          kind: 'tool_results',
          blocks: [{ type: 'tool_result', toolUseId: 'nobody', content: 'r' }],
        }),
        row({ seq: 6, role: 'user', blocks: [{ type: 'text', text: 'again' }] }),
      ],
      target,
      null
    );
    expect(history).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'calling' }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ]);
  });

  it('never opens with an assistant message', () => {
    const history = buildHistory(
      [row({ seq: 1, role: 'assistant', blocks: [{ type: 'text', text: 'orphan' }] })],
      target,
      null
    );
    expect(history).toEqual([]);
  });
});

describe('buildSystemPrompt', () => {
  it('mentions the project, its memory and files, and the person', () => {
    const prompt = buildSystemPrompt({
      personName: 'Dana',
      orgName: null,
      project: {
        name: 'Launch',
        instructions: 'Be brief.',
        memoryText: '- [2026-09-01 10:00] Ship date is Friday',
        files: [
          { id: 'f1', filename: 'plan.pdf', contentType: 'application/pdf', sizeBytes: 2048 },
        ],
      },
      chatFiles: [],
      hasTools: true,
      hasKnowledge: false,
      hasSandbox: true,
      filesAllowed: true,
      now: new Date('2026-09-04T10:00:00Z'),
    });
    expect(prompt).toContain('Dana');
    expect(prompt).toContain('project "Launch"');
    expect(prompt).toContain('Be brief.');
    expect(prompt).toContain('Ship date is Friday');
    expect(prompt).toContain('plan.pdf');
    expect(prompt).toContain('sandbox_*');
    expect(prompt).toContain('2026-09-04T10:00:00.000Z');
  });

  it('says how to hand the person a file, and which formats it can be', () => {
    const prompt = buildSystemPrompt({
      personName: null,
      orgName: null,
      project: null,
      chatFiles: [],
      hasTools: true,
      hasKnowledge: false,
      hasSandbox: false,
      filesAllowed: true,
      now: new Date('2026-09-04T10:00:00Z'),
    });
    expect(prompt).toContain('chat_write_file');
    expect(prompt).toMatch(/Artifacts/);
    expect(prompt).toMatch(/\.xlsx from CSV/);
    expect(prompt).toMatch(/never bytes or base64/);
    expect(prompt).not.toMatch(/Do not produce files/);
  });
});

describe('buildSystemPrompt with search_knowledge', () => {
  const base = {
    personName: null,
    orgName: null,
    project: null,
    chatFiles: [],
    hasTools: true,
    hasSandbox: false,
    filesAllowed: true,
    now: new Date('2026-09-04T00:00:00Z'),
  };

  it('says when a search is worth it and to search once, only when the tool is offered', () => {
    const withKnowledge = buildSystemPrompt({ ...base, hasKnowledge: true });
    expect(withKnowledge).toMatch(/search_knowledge finds what the organization has indexed/);
    expect(withKnowledge).toMatch(/Do not use it for general knowledge/);
    expect(withKnowledge).toMatch(/Make one well-aimed search/);
    expect(withKnowledge).toMatch(/not a rephrasing of the same one/);

    const without = buildSystemPrompt({ ...base, hasKnowledge: false });
    expect(without).not.toMatch(/search_knowledge/);
  });
});

describe('buildSystemPrompt without file storage', () => {
  it('tells the model not to produce files, and where storage is set up', () => {
    const prompt = buildSystemPrompt({
      personName: null,
      orgName: null,
      project: null,
      chatFiles: [],
      hasTools: true,
      hasKnowledge: false,
      hasSandbox: true,
      filesAllowed: false,
      now: new Date('2026-09-04T00:00:00Z'),
    });
    expect(prompt).toMatch(/no file storage set up/);
    expect(prompt).toMatch(/Do not produce files/);
    expect(prompt).toMatch(/Organization → Storage/);
  });
});
