import { isTemplateName, readInstanceSettings } from './types';

describe('readInstanceSettings', () => {
  it('reads a configured reset-password template name', () => {
    expect(readInstanceSettings({ resetPasswordTemplateName: 'Reset Password Template' })).toEqual({
      resetPasswordTemplateName: 'Reset Password Template',
    });
  });

  it('answers null for an empty, malformed or absent settings document', () => {
    for (const settings of [{}, null, undefined, 'x', [], 42]) {
      expect(readInstanceSettings(settings)).toEqual({ resetPasswordTemplateName: null });
    }
  });

  it('drops a template value that is not a usable name rather than failing the read', () => {
    for (const bad of ['', '   ', ' padded ', 'two\nlines', 7, { name: 'x' }, 'x'.repeat(256)]) {
      expect(readInstanceSettings({ resetPasswordTemplateName: bad })).toEqual({
        resetPasswordTemplateName: null,
      });
    }
  });
});

describe('isTemplateName', () => {
  it('accepts a plain one-line name up to the limit and refuses the rest', () => {
    expect(isTemplateName('Reset Password – must change at next logon')).toBe(true);
    expect(isTemplateName('x'.repeat(255))).toBe(true);
    expect(isTemplateName('x'.repeat(256))).toBe(false);
    expect(isTemplateName('')).toBe(false);
    expect(isTemplateName(' lead')).toBe(false);
    expect(isTemplateName('tab\there')).toBe(false);
    expect(isTemplateName(null)).toBe(false);
  });
});
