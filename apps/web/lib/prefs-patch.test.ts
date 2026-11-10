import { changedFields } from './prefs-patch';

describe('what a preference save sends', () => {
  it('only the fields that changed', () => {
    expect(
      changedFields(
        { mode: 'auto', codeLineNumbers: false },
        { mode: 'dark', codeLineNumbers: false }
      )
    ).toEqual({ mode: 'dark' });
  });

  it('a field changed to null or to an equal-looking copy', () => {
    expect(changedFields({ voice: 'a', rate: 1 }, { voice: null, rate: 1 })).toEqual({
      voice: null,
    });
    expect(changedFields({ list: [1, 2] }, { list: [1, 2] })).toEqual({});
  });

  it('nothing when nothing changed', () => {
    const prefs = { autoStart: true };
    expect(changedFields(prefs, { ...prefs })).toEqual({});
  });
});
