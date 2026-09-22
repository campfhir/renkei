/**
 * Which of Monaco's built-in languages a file is written in, by its
 * name — for the code pane's colouring only. There is no project-wide
 * type information on the client, so nothing here decides anything
 * smarter than a tokenizer; an unknown extension is plain text.
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
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  ps1: 'powershell',
  ini: 'ini',
  toml: 'ini',
  env: 'ini',
  lua: 'lua',
  swift: 'swift',
  dart: 'dart',
  r: 'r',
  pl: 'perl',
};

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  '.env': 'ini',
  '.gitignore': 'ini',
  '.npmrc': 'ini',
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
