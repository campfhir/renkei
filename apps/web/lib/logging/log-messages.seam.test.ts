/**
 * Log lines read as sentences about people and agents (docs/logging.md).
 *
 * Statically, across every app and package: a message template names
 * nobody by an id placeholder — a `{subject}`, `{agentId}` or `{chatId}`
 * in the message is the thing a reviewer cannot read, and the attribute
 * is stored and searchable without being in the message — and carries
 * no `[bracket]` prefix (`component` is an attribute). What a line says
 * about a person or an agent is each area's own test's business; this
 * one holds the floor.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..');
const SCANNED = ['apps', 'packages'];
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'e2e',
  'test-results',
  'coverage',
  'playwright-report',
]);

/** Ids a message never interpolates: the bag carries them, the sentence names the person or thing. */
const ID_PLACEHOLDERS = [
  'subject',
  'ownerSubject',
  'granteeSubject',
  'viewerSubject',
  'userId',
  'agentId',
  'chatId',
  'accountId',
  'sessionId',
  'grantId',
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) return [];
    const child = join(dir, entry.name);
    if (entry.isDirectory()) return sources(child);
    if (!/\.(ts|tsx|mjs)$/.test(entry.name)) return [];
    if (/\.test\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];
    return [child];
  });
}

/**
 * The message template of every `logger.<level>('…', …)` call whose
 * first argument is a plain string literal, with its line number.
 */
function messages(source: string): { line: number; message: string }[] {
  const out: { line: number; message: string }[] = [];
  const call =
    /\blogger\.(?:critical|error|warn|info|http|verbose|debug|log)\(\s*(?:'[a-z]+',\s*)?(['"`])((?:\\[\s\S]|(?!\1)[\s\S])*)\1/g;
  for (const match of source.matchAll(call)) {
    out.push({
      line: source.slice(0, match.index).split('\n').length,
      message: match[2],
    });
  }
  return out;
}

const files = SCANNED.flatMap((area) => sources(join(ROOT, area))).map((path) =>
  relative(ROOT, path).split(sep).join('/')
);

describe('log messages', () => {
  it('scans the apps and packages', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('name nobody by an id placeholder and carry no bracket prefix', () => {
    const offences: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      for (const { line, message } of messages(source)) {
        for (const key of ID_PLACEHOLDERS) {
          if (message.includes(`{${key}}`)) {
            offences.push(`${file}:${line} interpolates {${key}}: ${message}`);
          }
        }
        if (/^\s*\[/.test(message)) {
          offences.push(`${file}:${line} starts with a [bracket] prefix: ${message}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
