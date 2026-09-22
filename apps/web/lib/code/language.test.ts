import { languageForPath } from './language';

describe('languageForPath', () => {
  it('names Monaco’s language by extension', () => {
    expect(languageForPath('apps/web/lib/code/turn.ts')).toBe('typescript');
    expect(languageForPath('src/App.tsx')).toBe('typescript');
    expect(languageForPath('docs/chat.md')).toBe('markdown');
    expect(languageForPath('compose.yaml')).toBe('yaml');
    expect(languageForPath('Makefile')).toBe('plaintext');
  });

  it('knows a few files by name, whatever the case', () => {
    expect(languageForPath('docker/Dockerfile')).toBe('dockerfile');
    expect(languageForPath('.env')).toBe('ini');
    expect(languageForPath('README')).toBe('plaintext');
  });
});
