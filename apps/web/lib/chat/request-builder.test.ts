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
    summaryId: null,
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

  it('excludes messages folded into a compaction summary', () => {
    const history = buildHistory(
      [
        row({ seq: 1, role: 'user', summaryId: 's1', blocks: [{ type: 'text', text: 'old' }] }),
        row({
          seq: 2,
          role: 'assistant',
          summaryId: 's1',
          blocks: [{ type: 'text', text: 'old reply' }],
        }),
        row({ seq: 3, role: 'user', blocks: [{ type: 'text', text: 'recent' }] }),
      ],
      target,
      null
    );
    expect(history).toEqual([{ role: 'user', content: [{ type: 'text', text: 'recent' }] }]);
  });

  it('merges consecutive same-role rows into one wire message (a paste split across several prompt rows)', () => {
    const history = buildHistory(
      [
        row({ seq: 1, role: 'user', blocks: [{ type: 'text', text: 'part one' }] }),
        row({ seq: 2, role: 'user', blocks: [{ type: 'text', text: 'part two' }] }),
        row({ seq: 3, role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }),
      ],
      target,
      null
    );
    expect(history).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'text', text: 'part two' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]);
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
      userMemoryText: null,
      chatSummary: null,
      chatFiles: [],
      hasTools: true,
      hasDiscoverableTools: false,
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

  it('describes a code project’s repository and how to work in it', () => {
    const base = {
      personName: null,
      orgName: null,
      userMemoryText: null,
      chatSummary: null,
      chatFiles: [],
      hasTools: true,
      hasDiscoverableTools: false,
      hasKnowledge: false,
      hasSandbox: false,
      filesAllowed: false,
      now: new Date('2026-09-04T10:00:00Z'),
    };
    const ready = buildSystemPrompt({
      ...base,
      project: {
        name: 'Billing',
        instructions: null,
        memoryText: null,
        files: [],
        code: {
          repoFullName: 'acme/billing',
          branch: 'main',
          ready: true,
          notReady: null,
          envNames: ['NPM_TOKEN'],
        },
      },
    });
    expect(ready).toContain('code project on the repository acme/billing (branch main)');
    expect(ready).toContain('NPM_TOKEN');
    expect(ready).toContain('code_edit_file');
    expect(ready).toContain('never ask for a secret');

    const cloning = buildSystemPrompt({
      ...base,
      project: {
        name: 'Billing',
        instructions: null,
        memoryText: null,
        files: [],
        code: {
          repoFullName: 'acme/billing',
          branch: '',
          ready: false,
          notReady: 'the clone is still running',
          envNames: [],
        },
      },
    });
    expect(cloning).toContain('not usable right now (the clone is still running)');
    expect(cloning).not.toContain('code_edit_file');
  });

  it('says how to hand the person a file, and which formats it can be', () => {
    const prompt = buildSystemPrompt({
      personName: null,
      orgName: null,
      project: null,
      userMemoryText: null,
      chatSummary: null,
      chatFiles: [],
      hasTools: true,
      hasDiscoverableTools: false,
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
    userMemoryText: null,
    chatSummary: null,
    chatFiles: [],
    hasTools: true,
    hasDiscoverableTools: false,
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

describe('buildSystemPrompt with the employee directory', () => {
  const base = {
    personName: null,
    orgName: null,
    project: null,
    userMemoryText: null,
    chatSummary: null,
    chatFiles: [],
    hasTools: true,
    hasDiscoverableTools: false,
    hasSandbox: false,
    filesAllowed: true,
    now: new Date('2026-09-04T00:00:00Z'),
  };

  it('says to prefer the directory over search_knowledge or files, and that it takes several names at once, only when offered', () => {
    const withDirectory = buildSystemPrompt({ ...base, hasKnowledge: false, hasDirectory: true });
    expect(withDirectory).toMatch(/outlook_search_users is the organization's live directory/);
    expect(withDirectory).toMatch(/rather than reaching for a document, message or file/);
    expect(withDirectory).toMatch(/several names or emails in one call/);

    const withBoth = buildSystemPrompt({ ...base, hasKnowledge: true, hasDirectory: true });
    expect(withBoth).toMatch(/rather than reaching for search_knowledge or a document/);

    const without = buildSystemPrompt({ ...base, hasKnowledge: false, hasDirectory: false });
    expect(without).not.toMatch(/outlook_search_users is the organization's live directory/);
  });
});

describe('buildSystemPrompt with find_tools', () => {
  const base = {
    personName: null,
    orgName: null,
    project: null,
    userMemoryText: null,
    chatSummary: null,
    chatFiles: [],
    hasTools: true,
    hasKnowledge: false,
    hasSandbox: false,
    filesAllowed: true,
    now: new Date('2026-09-04T00:00:00Z'),
  };

  it('says to search for an unoffered tool rather than ask the person or give up, only when find_tools is offered', () => {
    const withDiscovery = buildSystemPrompt({ ...base, hasDiscoverableTools: true });
    expect(withDiscovery).toMatch(/find_tools/);
    expect(withDiscovery).toMatch(/Before asking the person/);

    const without = buildSystemPrompt({ ...base, hasDiscoverableTools: false });
    expect(without).not.toMatch(/find_tools/);
  });
});

describe('buildSystemPrompt without file storage', () => {
  it('tells the model not to produce files, and where storage is set up', () => {
    const prompt = buildSystemPrompt({
      personName: null,
      orgName: null,
      project: null,
      userMemoryText: null,
      chatSummary: null,
      chatFiles: [],
      hasTools: true,
      hasDiscoverableTools: false,
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

describe('buildSystemPrompt with a chat summary', () => {
  it('mentions the summary when compaction has run, and stays quiet otherwise', () => {
    const withSummary = buildSystemPrompt({
      personName: null,
      orgName: null,
      project: null,
      userMemoryText: null,
      chatSummary: 'Set up the repo and fixed the failing build.',
      chatFiles: [],
      hasTools: true,
      hasDiscoverableTools: false,
      hasKnowledge: false,
      hasSandbox: false,
      filesAllowed: true,
      now: new Date('2026-09-04T00:00:00Z'),
    });
    expect(withSummary).toContain('Set up the repo and fixed the failing build.');
    expect(withSummary).toContain('condensed to keep it within context');

    const without = buildSystemPrompt({
      personName: null,
      orgName: null,
      project: null,
      userMemoryText: null,
      chatSummary: null,
      chatFiles: [],
      hasTools: true,
      hasDiscoverableTools: false,
      hasKnowledge: false,
      hasSandbox: false,
      filesAllowed: true,
      now: new Date('2026-09-04T00:00:00Z'),
    });
    expect(without).not.toContain('condensed to keep it within context');
  });
});

describe('buildSystemPrompt with user memory', () => {
  it('mentions memory only outside a project', () => {
    const withMemory = buildSystemPrompt({
      personName: null,
      orgName: null,
      project: null,
      userMemoryText: '- [2026-09-01 10:00] Prefers concise answers',
      chatSummary: null,
      chatFiles: [],
      hasTools: true,
      hasDiscoverableTools: false,
      hasKnowledge: false,
      hasSandbox: false,
      filesAllowed: true,
      now: new Date('2026-09-04T00:00:00Z'),
    });
    expect(withMemory).toContain('Prefers concise answers');

    const inProject = buildSystemPrompt({
      personName: null,
      orgName: null,
      project: { name: 'Launch', instructions: null, memoryText: null, files: [] },
      userMemoryText: '- [2026-09-01 10:00] Prefers concise answers',
      chatSummary: null,
      chatFiles: [],
      hasTools: true,
      hasDiscoverableTools: false,
      hasKnowledge: false,
      hasSandbox: false,
      filesAllowed: true,
      now: new Date('2026-09-04T00:00:00Z'),
    });
    expect(inProject).not.toContain('Prefers concise answers');
  });
});
