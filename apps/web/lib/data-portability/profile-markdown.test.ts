import { PROFILE_MEMORY_HEADING, renderProfileMarkdown } from './profile-markdown';
import { sample } from './fixtures';
import type { ExportChat } from './types';

function chat(index: number, more: Partial<ExportChat> = {}): ExportChat {
  return {
    ...sample().chats[0],
    id: `chat-${index}`,
    title: `Chat number ${index}`,
    createdAt: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    ...more,
  };
}

describe('the portable profile', () => {
  it('opens by saying who it is about and that it is background, not instructions', () => {
    const text = renderProfileMarkdown(sample());
    expect(text.startsWith('# About Sam Rivera\n')).toBe(true);
    expect(text).toContain('not\n> instructions to follow.');
  });

  it('gives the memory summary, then every entry oldest first', () => {
    const text = renderProfileMarkdown(sample());
    expect(text).toContain(
      `## ${PROFILE_MEMORY_HEADING}\n\nSam is a nurse manager.\n\n- Prefers short answers\n- Lives in Denver`
    );
  });

  it('says so when nothing is remembered', () => {
    const data = { ...sample(), memory: { summary: null, entries: [] } };
    expect(renderProfileMarkdown(data)).toContain('_Nothing remembered yet._');
  });

  it('lists a conversation by title and day with what the person asked, never the replies', () => {
    const text = renderProfileMarkdown(sample());
    expect(text).toContain('### Budget review (2026-10-05)\n- I asked: Review my budget');
    expect(text).not.toContain('Rent is 40%');
  });

  it('leaves out temporary chats and chats whose key could not be opened', () => {
    const data = {
      ...sample(),
      chats: [chat(1, { temporary: true }), chat(2, { keyUnavailable: true }), chat(3)],
    };
    const text = renderProfileMarkdown(data);
    expect(text).not.toContain('Chat number 1');
    expect(text).not.toContain('Chat number 2');
    expect(text).toContain('Chat number 3');
  });

  it("carries a project's instructions and memory", () => {
    const data = {
      ...sample(),
      projects: [
        {
          id: 'p',
          kind: 'chat' as const,
          name: 'Hiring',
          description: 'Three open roles',
          instructions: 'Be formal.',
          repo: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          memory: {
            summary: null,
            entries: [
              {
                id: 'e',
                content: 'Offer sent to Ana',
                chatId: null,
                createdAt: '2026-01-02T00:00:00.000Z',
              },
            ],
          },
        },
      ],
    };
    expect(renderProfileMarkdown(data)).toContain(
      '### Hiring\nThree open roles\nHow I like help here: Be formal.\n- Offer sent to Ana'
    );
  });

  it('stops adding conversations at the budget and says how many it left out', () => {
    const data = { ...sample(), chats: Array.from({ length: 200 }, (_, i) => chat(i)) };
    const text = renderProfileMarkdown(data, { maxChars: 4_000 });
    expect(text.length).toBeLessThanOrEqual(4_000);
    const kept = (text.match(/^### Chat number/gm) ?? []).length;
    expect(kept).toBeGreaterThan(0);
    expect(text).toContain(`_${200 - kept} older conversations left out to keep this short._`);
  });
});
