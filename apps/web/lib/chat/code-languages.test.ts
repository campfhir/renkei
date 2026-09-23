import {
  CODE_ALIASES,
  canonicalLanguage,
  fenceLanguage,
  guessPaneLanguage,
  languageFromClassName,
  languageLabel,
  HIGHLIGHT_LIMIT,
} from './code-languages';

describe('fenceLanguage', () => {
  it('lower-cases the word and drops attribute or title suffixes', () => {
    expect(fenceLanguage('TypeScript')).toBe('typescript');
    expect(fenceLanguage('ts {1,3}')).toBe('ts');
    expect(fenceLanguage('js:src/app.js')).toBe('js');
    expect(fenceLanguage('  ')).toBeUndefined();
    expect(fenceLanguage(undefined)).toBeUndefined();
  });
});

describe('CODE_ALIASES', () => {
  it('names each alias once, for one grammar', () => {
    const seen = new Set<string>();
    for (const aliases of Object.values(CODE_ALIASES)) {
      for (const alias of aliases) {
        expect(seen.has(alias)).toBe(false);
        seen.add(alias);
      }
    }
  });

  it('sends the SQL dialects people type to the SQL grammar', () => {
    for (const word of ['postgres', 'psql', 'pgsql', 'mysql', 'tsql', 'sqlite']) {
      expect(canonicalLanguage(word)).toBe('sql');
    }
    expect(canonicalLanguage('env')).toBe('ini');
    expect(canonicalLanguage('ps1')).toBe('powershell');
    expect(canonicalLanguage('typescript')).toBe('typescript');
  });
});

describe('languageLabel', () => {
  it('gives the common languages their proper names', () => {
    expect(languageLabel('ts')).toBe('TypeScript');
    expect(languageLabel('typescript')).toBe('TypeScript');
    expect(languageLabel('js')).toBe('JavaScript');
    expect(languageLabel('yml')).toBe('YAML');
    expect(languageLabel('json')).toBe('JSON');
    expect(languageLabel('sql')).toBe('SQL');
    expect(languageLabel('sh')).toBe('Shell');
  });

  it('keeps a dialect’s own name where it has one', () => {
    expect(languageLabel('postgres')).toBe('PostgreSQL');
    expect(languageLabel('tsx')).toBe('TSX');
    expect(languageLabel('env')).toBe('.env');
    // An alias with no name of its own reads as its grammar.
    expect(languageLabel('cfg')).toBe('Config');
    expect(languageLabel('ndjson')).toBe('JSON Lines');
  });

  it('shows an unknown word as written, and nothing for an untagged fence', () => {
    expect(languageLabel('mumps')).toBe('mumps');
    expect(languageLabel(undefined)).toBeUndefined();
    expect(languageLabel('')).toBeUndefined();
  });
});

describe('languageFromClassName', () => {
  it('reads the language class the Markdown pipeline attaches', () => {
    expect(languageFromClassName('hljs language-sql')).toBe('sql');
    expect(languageFromClassName('language-ts')).toBe('ts');
    expect(languageFromClassName('hljs')).toBeUndefined();
    expect(languageFromClassName('language-')).toBeUndefined();
    expect(languageFromClassName(undefined)).toBeUndefined();
  });
});

describe('guessPaneLanguage', () => {
  it('calls a document JSON only when it parses as one', () => {
    expect(guessPaneLanguage('{"issues": []}')).toBe('json');
    expect(guessPaneLanguage('  [1, 2, 3]')).toBe('json');
    expect(guessPaneLanguage('{"issues": [')).toBeUndefined();
    expect(guessPaneLanguage('Found 2 issues:\n- OPS-41')).toBeUndefined();
    expect(guessPaneLanguage('')).toBeUndefined();
  });

  it('leaves a huge document plain', () => {
    const big = `[${'1,'.repeat(HIGHLIGHT_LIMIT / 2)}1]`;
    expect(guessPaneLanguage(big)).toBeUndefined();
  });
});
