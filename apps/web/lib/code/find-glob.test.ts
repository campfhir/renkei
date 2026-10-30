import { findGlob } from './find-glob';

describe('findGlob', () => {
  it('matches the typed text anywhere in a path', () => {
    expect(findGlob('bill')).toBe('**/*bill*');
    expect(findGlob('src/bil')).toBe('**/*src/bil*');
  });

  it('is every file for an empty query', () => {
    expect(findGlob('')).toBe('**/*');
    expect(findGlob('***')).toBe('**/*');
  });

  it('strips glob syntax, a leading slash and backslashes', () => {
    expect(findGlob('/src/[a]*.ts?')).toBe('**/*src/a.ts*');
    expect(findGlob('a\\b{c}!')).toBe('**/*abc*');
  });
});
