/**
 * Which of Monaco's built-in languages a file is written in, by its
 * name — for the code pane's colouring only. There is no project-wide
 * type information on the client, so nothing here decides anything
 * smarter than a tokenizer; an unknown extension is plain text. The
 * touch-screen editor colours with the chat's highlighter instead, so
 * `highlighterLanguageFor` says which of its grammars stands in for a
 * Monaco language.
 */

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  ndjson: 'json',
  webmanifest: 'json',
  md: 'markdown',
  mdx: 'mdx',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  vue: 'html',
  svelte: 'html',
  xml: 'xml',
  svg: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  xsd: 'xml',
  wsdl: 'xml',
  plist: 'xml',
  csproj: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  sql: 'sql',
  pgsql: 'pgsql',
  mysql: 'mysql',
  graphql: 'graphql',
  gql: 'graphql',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  ini: 'ini',
  toml: 'ini',
  env: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  editorconfig: 'ini',
  lua: 'lua',
  swift: 'swift',
  dart: 'dart',
  r: 'r',
  pl: 'perl',
  proto: 'protobuf',
  tf: 'hcl',
  tfvars: 'hcl',
  hcl: 'hcl',
  scala: 'scala',
  ex: 'elixir',
  exs: 'elixir',
  clj: 'clojure',
  jl: 'julia',
  m: 'objective-c',
  pas: 'pascal',
  fs: 'fsharp',
  vb: 'vb',
  tcl: 'tcl',
  hbs: 'handlebars',
  pug: 'pug',
  rst: 'restructuredtext',
  cshtml: 'razor',
  dockerfile: 'dockerfile',
  txt: 'plaintext',
  log: 'plaintext',
  csv: 'plaintext',
  hl7: 'plaintext',
};

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'plaintext',
  jenkinsfile: 'plaintext',
  '.env': 'ini',
  '.env.development': 'ini',
  '.env.local': 'ini',
  '.env.example': 'ini',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.dockerignore': 'ini',
  '.npmrc': 'ini',
  '.nvmrc': 'plaintext',
  '.editorconfig': 'ini',
  '.prettierrc': 'json',
  '.babelrc': 'json',
  '.eslintrc': 'json',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
};

export function languageForPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  return BY_EXTENSION[lower.slice(dot + 1)] ?? 'plaintext';
}

/**
 * Monaco's language names that the chat's highlighter calls something
 * else, or has no grammar for at all (`undefined`: the text stays plain).
 * Everything not listed shares its name between the two.
 */
const HIGHLIGHTER_NAMES: Record<string, string | undefined> = {
  shell: 'bash',
  html: 'xml',
  mdx: 'markdown',
  pgsql: 'sql',
  mysql: 'sql',
  bat: 'dos',
  'objective-c': 'objectivec',
  vb: 'vbnet',
  hcl: undefined,
  pascal: undefined,
  fsharp: undefined,
  tcl: undefined,
  handlebars: undefined,
  pug: undefined,
  restructuredtext: undefined,
  razor: undefined,
  scala: undefined,
  elixir: undefined,
  clojure: undefined,
  julia: undefined,
  dart: undefined,
};

/** The chat highlighter's grammar for one of Monaco's languages, if it has one. */
export function highlighterLanguageFor(monacoLanguage: string): string | undefined {
  if (monacoLanguage === 'plaintext') return undefined;
  return monacoLanguage in HIGHLIGHTER_NAMES ? HIGHLIGHTER_NAMES[monacoLanguage] : monacoLanguage;
}
