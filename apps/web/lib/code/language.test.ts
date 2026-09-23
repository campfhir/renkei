import { highlighterLanguageFor, languageForPath } from './language';

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

describe('languageForPath, the longer tail', () => {
  it('knows the files an integration repository carries', () => {
    expect(languageForPath('infra/main.tf')).toBe('hcl');
    expect(languageForPath('api/schema.proto')).toBe('protobuf');
    expect(languageForPath('scripts/deploy.psm1')).toBe('powershell');
    expect(languageForPath('scripts/run.cmd')).toBe('bat');
    expect(languageForPath('db/report.pgsql')).toBe('pgsql');
    expect(languageForPath('config/app.properties')).toBe('ini');
    expect(languageForPath('data/events.jsonl')).toBe('json');
    expect(languageForPath('views/Index.cshtml')).toBe('razor');
    expect(languageForPath('samples/adt.hl7')).toBe('plaintext');
  });

  it('knows more dotfiles and bare names', () => {
    expect(languageForPath('.env.development')).toBe('ini');
    expect(languageForPath('.prettierrc')).toBe('json');
    expect(languageForPath('.zshrc')).toBe('shell');
    expect(languageForPath('ci/Jenkinsfile')).toBe('plaintext');
    expect(languageForPath('Containerfile')).toBe('dockerfile');
  });
});

describe('highlighterLanguageFor', () => {
  it('shares a name with Monaco where the highlighter has the grammar', () => {
    expect(highlighterLanguageFor('typescript')).toBe('typescript');
    expect(highlighterLanguageFor('sql')).toBe('sql');
    expect(highlighterLanguageFor('yaml')).toBe('yaml');
    expect(highlighterLanguageFor('dockerfile')).toBe('dockerfile');
  });

  it('translates the names that differ', () => {
    expect(highlighterLanguageFor('shell')).toBe('bash');
    expect(highlighterLanguageFor('html')).toBe('xml');
    expect(highlighterLanguageFor('pgsql')).toBe('sql');
    expect(highlighterLanguageFor('objective-c')).toBe('objectivec');
  });

  it('has nothing for plain text or a language the highlighter lacks', () => {
    expect(highlighterLanguageFor('plaintext')).toBeUndefined();
    expect(highlighterLanguageFor('hcl')).toBeUndefined();
  });
});
