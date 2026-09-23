/**
 * What a fenced code block's language word means: which grammar colours
 * it and what the block's header calls it. Pure data, so the chat's
 * Markdown renderer, the tool-call panes and a unit test can all share
 * it without pulling the highlighter in; lib/chat/code-grammars.ts is
 * the half that registers grammars.
 *
 * The highlighter already knows the common short forms (`ts`, `js`,
 * `yml`, `sh`, `jsonc`, `html`). What people actually type at a fence
 * goes further than that — `postgres`, `psql`, `mysql` for a query,
 * `env` for a dotenv file, `ps1` for a PowerShell script — and a word
 * the highlighter has never heard of leaves the block plain. The alias
 * table below maps those onto the grammar that fits; the label table
 * gives the header a proper name (`TypeScript`, not `ts`).
 */

/** Extra names for registered grammars: grammar → the words a fence may use. */
export const CODE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  sql: [
    'postgres',
    'postgresql',
    'pgsql',
    'psql',
    'plpgsql',
    'mysql',
    'mariadb',
    'sqlite',
    'tsql',
    'mssql',
    'plsql',
    'oracle',
  ],
  javascript: ['node', 'es6', 'rhino'],
  json: ['jsonl', 'ndjson'],
  yaml: ['yml'],
  ini: ['env', 'dotenv', 'cfg'],
  xml: ['htm', 'xsl', 'xslt', 'xsd', 'wsdl'],
  plaintext: ['plain', 'log', 'logs', 'output'],
  markdown: ['mdx'],
  dockerfile: ['containerfile'],
  powershell: ['ps1', 'pwsh', 'ps'],
  makefile: ['mk'],
};

/**
 * What the header calls a language. Keyed by the word in the fence first
 * (so `postgres` reads PostgreSQL, `tsx` reads TSX), then by the grammar
 * it resolves to; a word in neither table is shown as written.
 */
const LABELS: Readonly<Record<string, string>> = {
  // Grammars.
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  yaml: 'YAML',
  sql: 'SQL',
  bash: 'Bash',
  shell: 'Shell',
  xml: 'XML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  markdown: 'Markdown',
  diff: 'Diff',
  ini: 'INI',
  dockerfile: 'Dockerfile',
  powershell: 'PowerShell',
  http: 'HTTP',
  properties: 'Properties',
  protobuf: 'Protobuf',
  nginx: 'nginx',
  groovy: 'Groovy',
  python: 'Python',
  'python-repl': 'Python',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  kotlin: 'Kotlin',
  csharp: 'C#',
  c: 'C',
  cpp: 'C++',
  ruby: 'Ruby',
  php: 'PHP',
  'php-template': 'PHP',
  swift: 'Swift',
  graphql: 'GraphQL',
  makefile: 'Makefile',
  lua: 'Lua',
  perl: 'Perl',
  r: 'R',
  objectivec: 'Objective-C',
  vbnet: 'VB.NET',
  wasm: 'WebAssembly',
  arduino: 'Arduino',
  plaintext: 'Text',
  // Words in a fence that deserve their own name.
  ts: 'TypeScript',
  tsx: 'TSX',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JSX',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  node: 'Node.js',
  jsonc: 'JSONC',
  json5: 'JSON5',
  jsonl: 'JSON Lines',
  ndjson: 'JSON Lines',
  yml: 'YAML',
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  pgsql: 'PostgreSQL',
  psql: 'PostgreSQL',
  plpgsql: 'PL/pgSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  sqlite: 'SQLite',
  tsql: 'T-SQL',
  mssql: 'T-SQL',
  plsql: 'PL/SQL',
  oracle: 'PL/SQL',
  sh: 'Shell',
  zsh: 'zsh',
  console: 'Console',
  shellsession: 'Console',
  html: 'HTML',
  htm: 'HTML',
  svg: 'SVG',
  xhtml: 'XHTML',
  xsl: 'XSLT',
  xslt: 'XSLT',
  xsd: 'XSD',
  wsdl: 'WSDL',
  env: '.env',
  dotenv: '.env',
  toml: 'TOML',
  cfg: 'Config',
  ps1: 'PowerShell',
  pwsh: 'PowerShell',
  ps: 'PowerShell',
  py: 'Python',
  gql: 'GraphQL',
  cs: 'C#',
  rs: 'Rust',
  rb: 'Ruby',
  kt: 'Kotlin',
  golang: 'Go',
  md: 'Markdown',
  mdx: 'MDX',
  patch: 'Patch',
  txt: 'Text',
  text: 'Text',
  plain: 'Text',
  log: 'Log',
  logs: 'Log',
  output: 'Output',
  docker: 'Dockerfile',
  containerfile: 'Containerfile',
  proto: 'Protobuf',
  hl7: 'HL7',
  jql: 'JQL',
  csv: 'CSV',
};

/** The fence's language word, lower-cased and stripped of any `{...}` or `:title` suffix. */
export function fenceLanguage(word: string | null | undefined): string | undefined {
  if (!word) return undefined;
  const bare = word
    .trim()
    .toLowerCase()
    .split(/[\s{:,]/)[0];
  return bare ? bare : undefined;
}

/** What the block's header shows for a fence's language word; nothing for an untagged fence. */
export function languageLabel(word: string | null | undefined): string | undefined {
  const name = fenceLanguage(word);
  if (!name) return undefined;
  return LABELS[name] ?? LABELS[canonicalLanguage(name)] ?? name;
}

/** The grammar an alias stands for, or the word itself when it is no alias. */
export function canonicalLanguage(name: string): string {
  for (const [grammar, aliases] of Object.entries(CODE_ALIASES)) {
    if (aliases.includes(name)) return grammar;
  }
  return name;
}

/**
 * The language a `<code class="language-…">` element was fenced with:
 * the class the Markdown pipeline attaches to it. Unrelated classes (the
 * highlighter's own `hljs`) are skipped.
 */
export function languageFromClassName(className: string | null | undefined): string | undefined {
  if (!className) return undefined;
  for (const token of className.split(/\s+/)) {
    if (token.startsWith('language-') && token.length > 'language-'.length) {
      return token.slice('language-'.length);
    }
  }
  return undefined;
}

/** Past this many characters a pane is shown plain; colouring it would cost more than it shows. */
export const HIGHLIGHT_LIMIT = 100_000;

/**
 * A tool result is coloured only when it plainly is JSON — most tools
 * answer with it, and a JSON document that parses is safe to call one.
 * Anything else (prose, a log, a table of text) stays as it is: a guess
 * that colours the wrong thing is worse than none.
 */
export function guessPaneLanguage(text: string): 'json' | undefined {
  if (text.length > HIGHLIGHT_LIMIT) return undefined;
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[') return undefined;
  try {
    JSON.parse(text);
    return 'json';
  } catch {
    return undefined;
  }
}
