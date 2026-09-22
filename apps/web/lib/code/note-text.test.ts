import { noteFromInput, noteText, parseNote } from './note-text';

describe('noteText / parseNote', () => {
  it('round-trips an edit', () => {
    const note = { type: 'edit' as const, paths: ['apps/web/lib/code/turn.ts', 'docs/chat.md'] };
    expect(parseNote(noteText(note))).toEqual(note);
    expect(noteText(note)).toContain('uncommitted');
  });

  it('writes a commit the commit tool’s way on its first line', () => {
    const note = {
      type: 'commit' as const,
      branch: 'claude/env-masking',
      sha: 'a91f3c2',
      subject: 'Mask env values',
    };
    const text = noteText(note);
    expect(text.split('\n')[0]).toBe('Committed on claude/env-masking: a91f3c2 Mask env values');
    expect(parseNote(text)).toEqual(note);
  });

  it('round-trips a push', () => {
    const note = { type: 'push' as const, branch: 'main', remoteBranch: 'main' };
    expect(parseNote(noteText(note))).toEqual(note);
  });

  it('is null for anything else', () => {
    expect(parseNote('Hello there')).toBeNull();
    expect(parseNote('')).toBeNull();
  });
});

describe('noteFromInput', () => {
  it('accepts the three shapes and refuses the rest', () => {
    expect(noteFromInput({ type: 'edit', paths: ['a.ts', ' b.ts '] })).toEqual({
      type: 'edit',
      paths: ['a.ts', 'b.ts'],
    });
    expect(noteFromInput({ type: 'edit', paths: [] })).toBeNull();
    expect(noteFromInput({ type: 'commit', branch: 'main', sha: 'zz', subject: 'x' })).toBeNull();
    expect(
      noteFromInput({ type: 'commit', branch: 'main', sha: 'abc1234', subject: 'Fix\nmore' })
    ).toEqual({ type: 'commit', branch: 'main', sha: 'abc1234', subject: 'Fix' });
    expect(noteFromInput({ type: 'push', branch: 'main', remoteBranch: 'main' })).toEqual({
      type: 'push',
      branch: 'main',
      remoteBranch: 'main',
    });
    expect(noteFromInput({ type: 'other' })).toBeNull();
    expect(noteFromInput('edit')).toBeNull();
  });
});
