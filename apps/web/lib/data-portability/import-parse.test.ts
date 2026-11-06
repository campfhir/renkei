import {
  IMPORT_MAX_CHATS,
  IMPORT_MAX_MEMORIES,
  chunkText,
  htmlToText,
  memoriesFromText,
  normalizeMessages,
  parseImportFiles,
} from './import-parse';
import { renderProfileMarkdown } from './profile-markdown';
import { exportFiles } from './export-bundle';
import { sample } from './fixtures';

const json = (name: string, value: unknown) => ({ name, text: JSON.stringify(value) });

function chatGptConversation(title: string, createTime: number, turns: [string, string][]) {
  // A tree: root (no message) → system → alternating user/assistant, plus a
  // regenerated reply on a side branch the person did not keep.
  const mapping: Record<string, unknown> = {
    root: { id: 'root', message: null, parent: null, children: ['sys'] },
    sys: {
      id: 'sys',
      parent: 'root',
      message: {
        author: { role: 'system' },
        content: { content_type: 'text', parts: [''] },
        metadata: { is_visually_hidden_from_conversation: true },
      },
    },
  };
  let parent = 'sys';
  turns.forEach(([role, text], index) => {
    const id = `n${index}`;
    mapping[id] = {
      id,
      parent,
      message: {
        author: { role },
        create_time: createTime + index,
        content: { content_type: 'text', parts: [text] },
        metadata: {},
      },
    };
    parent = id;
  });
  mapping.abandoned = {
    id: 'abandoned',
    parent: 'n0',
    message: {
      author: { role: 'assistant' },
      content: { content_type: 'text', parts: ['A reply the person regenerated away'] },
    },
  };
  return { title, create_time: createTime, mapping, current_node: parent };
}

describe('importing a ChatGPT export', () => {
  it('follows the branch the person last saw, leaving out hidden and abandoned messages', () => {
    const plan = parseImportFiles([
      json('conversations.json', [
        chatGptConversation('Trip to Lisbon', 1_700_000_000, [
          ['user', 'Plan three days in Lisbon'],
          ['assistant', 'Day one: Alfama.'],
          ['user', 'Add a food tour'],
          ['assistant', 'Day two: Time Out Market.'],
        ]),
      ]),
    ]);
    expect(plan.sources).toEqual(['chatgpt']);
    expect(plan.chats).toHaveLength(1);
    expect(plan.chats[0]).toMatchObject({
      title: 'Trip to Lisbon',
      source: 'chatgpt',
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(plan.chats[0].messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Plan three days in Lisbon'],
      ['assistant', 'Day one: Alfama.'],
      ['user', 'Add a food tour'],
      ['assistant', 'Day two: Time Out Market.'],
    ]);
  });

  it('keeps the words of a message with an image, and skips code-interpreter output', () => {
    const conversation = {
      title: 'Receipt',
      create_time: 1_700_000_000,
      current_node: 'b',
      mapping: {
        a: {
          parent: null,
          message: {
            author: { role: 'user' },
            content: {
              content_type: 'multimodal_text',
              parts: [{ asset_pointer: 'file-service://x' }, 'What does this receipt total?'],
            },
          },
        },
        tool: {
          parent: 'a',
          message: {
            author: { role: 'tool' },
            content: { content_type: 'execution_output', text: '42' },
          },
        },
        b: {
          parent: 'tool',
          message: {
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['$42.'] },
          },
        },
      },
    };
    const plan = parseImportFiles([json('conversations.json', [conversation])]);
    expect(plan.chats[0].messages.map((m) => m.text)).toEqual([
      'What does this receipt total?',
      '$42.',
    ]);
  });

  it('names an untitled conversation after its first question', () => {
    const conversation = chatGptConversation('', 1_700_000_000, [
      ['user', 'How do I repot a fiddle-leaf fig?'],
      ['assistant', 'Gently.'],
    ]);
    const plan = parseImportFiles([json('conversations.json', [conversation])]);
    expect(plan.chats[0].title).toBe('How do I repot a fiddle-leaf fig?');
  });

  it('says nothing about the side files an export carries once its conversations are read', () => {
    const plan = parseImportFiles([
      json('conversations.json', [
        chatGptConversation('A', 1_700_000_000, [
          ['user', 'hi'],
          ['assistant', 'hello'],
        ]),
      ]),
      json('message_feedback.json', [{ rating: 'thumbsUp' }]),
      { name: 'chat.html', text: '<html></html>' },
    ]);
    expect(plan.notes).toEqual([]);
  });
});

describe('importing a Claude export', () => {
  it('reads conversations, preferring content blocks over the flat text', () => {
    const plan = parseImportFiles([
      json('conversations.json', [
        {
          uuid: 'c1',
          name: 'Quarterly report',
          created_at: '2026-02-01T10:00:00.000Z',
          chat_messages: [
            {
              sender: 'human',
              text: 'flat',
              content: [{ type: 'text', text: 'Draft the Q1 report' }],
              created_at: '2026-02-01T10:00:00.000Z',
            },
            {
              sender: 'assistant',
              text: 'Here is a draft.',
              created_at: '2026-02-01T10:00:05.000Z',
            },
          ],
        },
      ]),
    ]);
    expect(plan.sources).toEqual(['claude']);
    expect(plan.chats[0].title).toBe('Quarterly report');
    expect(plan.chats[0].messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Draft the Q1 report'],
      ['assistant', 'Here is a draft.'],
    ]);
  });

  it("turns Claude's prose memory into entries, leaving out its section labels", () => {
    const plan = parseImportFiles([
      json('memories.json', [
        {
          conversations_memory:
            '**Work context**\n\nSam is a nurse manager at a regional hospital.\n\n**Personal context**\n\nSam runs half-marathons and is learning Portuguese.',
          project_memories: { p1: 'The hiring project tracks three open roles.' },
        },
      ]),
    ]);
    expect(plan.memories).toEqual([
      'Sam is a nurse manager at a regional hospital.',
      'Sam runs half-marathons and is learning Portuguese.',
      'The hiring project tracks three open roles.',
    ]);
    expect(plan.chats).toEqual([]);
  });
});

describe('importing Gemini activity from Google Takeout', () => {
  it("gathers each day's prompts into one chat, oldest first, replies as text", () => {
    const plan = parseImportFiles([
      json('Takeout/My Activity/Gemini Apps/MyActivity.json', [
        {
          header: 'Gemini Apps',
          title: 'Prompted what should I pack?',
          time: '2026-03-02T09:30:00.000Z',
          safeHtmlItem: [{ html: '<p>Pack <b>light</b>:</p><ul><li>Rain jacket</li></ul>' }],
        },
        {
          header: 'Gemini Apps',
          title: 'Prompted weather in Porto',
          time: '2026-03-02T08:00:00.000Z',
          safeHtmlItem: [{ html: '<p>Mild &amp; wet.</p>' }],
        },
        { header: 'Gemini Apps', title: 'Used Gemini Apps', time: '2026-03-02T07:00:00.000Z' },
        {
          header: 'Gemini Apps',
          title: 'Prompted hello',
          time: '2026-03-01T08:00:00.000Z',
        },
      ]),
    ]);
    expect(plan.sources).toEqual(['gemini']);
    expect(plan.chats.map((chat) => chat.title)).toEqual([
      'Gemini, 2026-03-01',
      'Gemini, 2026-03-02',
    ]);
    expect(plan.chats[1].messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'weather in Porto'],
      ['assistant', 'Mild & wet.'],
      ['user', 'what should I pack?'],
      ['assistant', 'Pack light:\n\n- Rain jacket'],
    ]);
  });
});

describe('importing Markdown or plain text', () => {
  it('takes each list item as a memory, dropping date stamps and headings', () => {
    const plan = parseImportFiles([
      {
        name: 'pasted.md',
        text: '# What ChatGPT knows about me\n\n- [2026-01-04] Prefers metric units\n* Has two cats\n1. Works in Denver',
      },
    ]);
    expect(plan.sources).toEqual(['markdown']);
    expect(plan.memories).toEqual(['Prefers metric units', 'Has two cats', 'Works in Denver']);
  });

  it('takes a block of short lines one per memory, and paragraphs one each', () => {
    expect(memoriesFromText('Likes tea\nVegetarian\nLives in Oslo')).toEqual([
      'Likes tea',
      'Vegetarian',
      'Lives in Oslo',
    ]);
    expect(
      memoriesFromText('Runs a bakery.\nOpens at six.\n\nHas a sourdough starter named Bob.')
    ).toEqual(['Runs a bakery. Opens at six.', 'Has a sourdough starter named Bob.']);
  });

  it('splits a memory longer than the limit at sentence ends', () => {
    const long = `${'A fact about the person. '.repeat(30)}`.trim();
    const pieces = memoriesFromText(`- ${long}`);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= 500)).toBe(true);
    expect(pieces.join(' ')).toBe(long);
  });

  it('drops repeats, ignoring case and spacing', () => {
    const plan = parseImportFiles([
      { name: 'a.md', text: '- Has two cats\n- has  two cats\n- Likes tea' },
    ]);
    expect(plan.memories).toEqual(['Has two cats', 'Likes tea']);
  });

  it('reads back only the memory section of a profile exported here', () => {
    const profile = renderProfileMarkdown(sample());
    const plan = parseImportFiles([{ name: 'profile.md', text: profile }]);
    expect(plan.memories).toEqual(['Prefers short answers', 'Lives in Denver']);
  });

  it('says what it could not read when nothing was recognised', () => {
    const plan = parseImportFiles([
      { name: 'data.json', text: '{"hello": 1}' },
      { name: 'x.json', text: 'nope' },
    ]);
    expect(plan.sources).toEqual([]);
    expect(plan.notes).toEqual(['Not recognised, left out: data.json, x.json.']);
  });
});

describe('importing a Renkei export', () => {
  it('restores memory oldest first and chats from their JSON, ignoring the Markdown copies', () => {
    const files = exportFiles(sample()).map((file) => ({
      name: `export/${file.path}`,
      text: file.content,
    }));
    const plan = parseImportFiles(files);
    expect(plan.sources).toEqual(['renkei']);
    expect(plan.memories).toEqual(['Prefers short answers', 'Lives in Denver']);
    expect(plan.chats).toHaveLength(1);
    expect(plan.chats[0]).toMatchObject({ title: 'Budget review', source: 'renkei' });
    // Tool results are not conversation; the person's words and the replies are.
    expect(plan.chats[0].messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Review my budget'],
      ['assistant', 'Rent is 40% of income.'],
    ]);
  });
});

describe('what a chat keeps', () => {
  it('joins consecutive messages of one role and drops empty ones', () => {
    const { messages } = normalizeMessages([
      { role: 'user', text: 'one', createdAt: null },
      { role: 'user', text: '  ', createdAt: null },
      { role: 'user', text: 'two', createdAt: null },
      { role: 'assistant', text: 'reply', createdAt: null },
    ]);
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'one\n\ntwo'],
      ['assistant', 'reply'],
    ]);
  });

  it('leaves out a chat with nothing the person said', () => {
    const plan = parseImportFiles([
      json('conversations.json', [
        { name: 'empty', chat_messages: [{ sender: 'assistant', text: 'How can I help?' }] },
      ]),
    ]);
    expect(plan.chats).toEqual([]);
  });

  it(`keeps the newest ${IMPORT_MAX_CHATS} chats, written oldest first, and says how many were left out`, () => {
    const conversations = Array.from({ length: IMPORT_MAX_CHATS + 2 }, (_, index) => ({
      name: `Chat ${index}`,
      created_at: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      chat_messages: [{ sender: 'human', text: `question ${index}` }],
    }));
    const plan = parseImportFiles([json('conversations.json', conversations)]);
    expect(plan.chats).toHaveLength(IMPORT_MAX_CHATS);
    expect(plan.chats[0].title).toBe('Chat 2');
    expect(plan.chats.at(-1)?.title).toBe(`Chat ${IMPORT_MAX_CHATS + 1}`);
    expect(plan.notes).toContain(
      `2 older chats left out: one import brings at most ${IMPORT_MAX_CHATS}.`
    );
  });

  it(`keeps at most ${IMPORT_MAX_MEMORIES} memories`, () => {
    const text = Array.from({ length: IMPORT_MAX_MEMORIES + 5 }, (_, i) => `- fact ${i}`).join(
      '\n'
    );
    const plan = parseImportFiles([{ name: 'm.txt', text }]);
    expect(plan.memories).toHaveLength(IMPORT_MAX_MEMORIES);
    expect(plan.notes[0]).toMatch(/^5 memories left out/);
  });
});

describe('text helpers', () => {
  it('turns HTML entities and lists into text', () => {
    expect(htmlToText('<p>a &lt;b&gt; &#39;c&#x27;</p><ol><li>one</li><li>two</li></ol>')).toBe(
      "a <b> 'c'\n\n- one\n- two"
    );
  });

  it('drops script and style contents, however their closing tag is spaced or cased', () => {
    expect(htmlToText('<p>a</p><script>alert(1)</script ><STYLE>b{}</STYLE>c')).toBe('a\nc');
    expect(htmlToText('<script type="x">never</script\n>after')).toBe('after');
  });

  it('keeps an encoded tag as the text it spells, decoded once', () => {
    expect(htmlToText('&lt;script&gt;x&lt;/script&gt; &amp;lt;')).toBe('<script>x</script> &lt;');
  });

  it('drops an unclosed tag and everything after it, and stray brackets in text survive', () => {
    expect(htmlToText('1 > 0 <b>bold</b> <i')).toBe('1 > 0 bold');
  });

  it('finishes quickly on long hostile input', () => {
    const started = performance.now();
    htmlToText(`${' '.repeat(50_000)}x${'<'.repeat(20_000)}`);
    chunkText('a'.repeat(100_000), 500);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('cuts a sentence with no stops into pieces of the limit', () => {
    expect(chunkText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });
});
