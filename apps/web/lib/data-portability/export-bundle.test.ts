import {
  chatFileStem,
  chatTranscriptMarkdown,
  exportFileName,
  exportFiles,
  slugOf,
} from './export-bundle';
import { sample } from './fixtures';
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION } from './types';

const byPath = (data = sample()) =>
  new Map(exportFiles(data).map((file) => [file.path, file.content]));

describe('the export zip', () => {
  it('holds every part of the person’s data, a JSON and a transcript per chat', () => {
    const stem = chatFileStem(sample().chats[0]);
    expect([...byPath().keys()]).toEqual([
      'README.md',
      'manifest.json',
      'account.json',
      'preferences.json',
      'memory.json',
      'memory.md',
      'projects.json',
      'profile.md',
      'chats/index.json',
      `chats/${stem}.json`,
      `chats/${stem}.md`,
    ]);
  });

  it('names its format, version and counts in the manifest', () => {
    expect(JSON.parse(byPath().get('manifest.json')!)).toEqual({
      format: EXPORT_FORMAT,
      version: EXPORT_FORMAT_VERSION,
      exportedAt: '2026-11-06T12:00:00.000Z',
      counts: { chats: 1, messages: 4, memoryEntries: 2, projects: 0, preferences: 1 },
    });
  });

  it('keeps preferences by key, values as stored', () => {
    expect(JSON.parse(byPath().get('preferences.json')!)).toEqual({ theme: { mode: 'dark' } });
  });

  it('keeps every block of a chat in its JSON, tool results included', () => {
    const stem = chatFileStem(sample().chats[0]);
    const chat = JSON.parse(byPath().get(`chats/${stem}.json`)!);
    expect(chat.messages[2].blocks).toEqual([
      { type: 'tool_result', toolUseId: 't1', content: 'rent: 2000' },
    ]);
  });

  it('points each index line at its chat’s files', () => {
    const stem = chatFileStem(sample().chats[0]);
    expect(JSON.parse(byPath().get('chats/index.json')!)[0]).toMatchObject({
      title: 'Budget review',
      messages: 4,
      json: `chats/${stem}.json`,
      markdown: `chats/${stem}.md`,
    });
  });

  it('is named for the day it was made', () => {
    expect(exportFileName('2026-11-06T12:00:00.000Z')).toBe('renkei-export-2026-11-06.zip');
  });
});

describe('a chat transcript', () => {
  it('shows the person and the replies, notes tool use, and leaves tool results out', () => {
    const text = chatTranscriptMarkdown(sample().chats[0]);
    expect(text).toContain('# Budget review\n\nStarted 2026-10-05');
    expect(text).toContain('**You** · 2026-10-05 09:00\n\nReview my budget');
    expect(text).toContain('_Used the tool `read_sheet`._');
    expect(text).toContain('**Assistant (stub)** · 2026-10-05 09:00\n\nRent is 40% of income.');
    expect(text).not.toContain('rent: 2000');
  });

  it('says when its key could not be opened', () => {
    const text = chatTranscriptMarkdown({ ...sample().chats[0], keyUnavailable: true });
    expect(text).toContain('could not open');
  });
});

describe('file names', () => {
  it('are safe everywhere and sort by day', () => {
    expect(slugOf('Café: plans / ideas!!')).toBe('cafe-plans-ideas');
    expect(slugOf(null)).toBe('untitled');
    expect(slugOf('???')).toBe('untitled');
    expect(slugOf('a'.repeat(60))).toHaveLength(48);
    expect(chatFileStem(sample().chats[0])).toBe('2026-10-05-budget-review-11111111');
  });
});
