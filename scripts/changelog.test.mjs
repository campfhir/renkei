import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addEntry, isProductPath, optsOut, validate } from './changelog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-10-24T12:00:00Z');

const release = (date, entries = [{ kind: 'added', title: 'A thing', detail: 'It works.' }]) =>
  `{\n  date: ${date},\n  entries: [\n${entries
    .map((e) => `{ kind: '${e.kind}', title: '${e.title}', detail: '${e.detail}' },`)
    .join('\n')}\n  ],\n},`;

const file = (...releases) =>
  `export const CHANGELOG: ChangelogRelease[] = [\n${releases.join('\n')}\n];\n`;

// Against the real clock: the fixed NOW below keeps the synthetic cases
// deterministic, but a real entry dated after it would read as "future".
test('the repository changelog is well-formed', () => {
  const source = readFileSync(path.join(ROOT, 'apps/web/lib/changelog.ts'), 'utf8');
  assert.deepEqual(validate(source), []);
});

test('a release with a real date and entries is accepted', () => {
  assert.deepEqual(validate(file(release("'2026-10-20'")), NOW), []);
});

test('a null date is rejected', () => {
  const problems = validate(file(release('null')), NOW);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /null and missing dates are not allowed/);
});

test('a missing date is rejected', () => {
  const problems = validate(
    file(`{\n  entries: [{ kind: 'added', title: 't', detail: 'd' }],\n},`),
    NOW
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /null and missing dates are not allowed/);
});

test('an impossible calendar date is rejected', () => {
  const problems = validate(file(release("'2026-02-30'")), NOW);
  assert.match(problems[0], /not a real YYYY-MM-DD date/);
});

test('a future date is rejected, with a day of slack for time zones', () => {
  assert.deepEqual(validate(file(release("'2026-10-23'")), NOW), []);
  assert.match(validate(file(release("'2026-10-26'")), NOW)[0], /in the future/);
});

test('releases out of newest-first order are rejected', () => {
  const problems = validate(file(release("'2026-10-10'"), release("'2026-10-20'")), NOW);
  assert.match(problems[0], /newest first/);
});

test('a release with no entries or an unknown kind is rejected', () => {
  assert.match(validate(file(release("'2026-10-20'", [])), NOW)[0], /non-empty array/);
  const problems = validate(
    file(release("'2026-10-20'", [{ kind: 'new', title: 't', detail: 'd' }])),
    NOW
  );
  assert.match(problems[0], /kind must be one of/);
});

test('product code counts, tests, docs and the changelog itself do not', () => {
  assert.equal(isProductPath('apps/web/lib/chat.ts'), true);
  assert.equal(isProductPath('packages/db/src/index.ts'), true);
  assert.equal(isProductPath('docker/Dockerfile'), true);
  assert.equal(isProductPath('apps/web/lib/chat.test.ts'), false);
  assert.equal(isProductPath('apps/web/e2e/voice.spec.ts'), false);
  assert.equal(isProductPath('apps/web/scripts/rekey.ts'), false);
  assert.equal(isProductPath('apps/web/README.md'), false);
  assert.equal(isProductPath('apps/web/lib/changelog.ts'), false);
  assert.equal(isProductPath('docs/notes.md'), false);
  assert.equal(isProductPath('pnpm-lock.yaml'), false);
});

test('a Changelog: none line opts a commit out', () => {
  assert.equal(optsOut(['Refactor the query builder\n\nChangelog: none\n']), true);
  assert.equal(optsOut(['Refactor the query builder\n\nno changelog mention\n']), false);
});

test('addEntry opens a new release for a new date', () => {
  const before = file(release("'2026-10-20'"));
  const after = addEntry(before, {
    date: '2026-10-22',
    kind: 'fixed',
    title: 'Fixed "quotes"',
    detail: "It's fixed.",
  });
  assert.deepEqual(validate(after, NOW), []);
  assert.match(after, /date: '2026-10-22'/);
  assert.ok(after.indexOf("'2026-10-22'") < after.indexOf("'2026-10-20'"));
});

test('addEntry leads an existing release dated today', () => {
  const before = file(release("'2026-10-22'", [{ kind: 'added', title: 'Old', detail: 'x' }]));
  const after = addEntry(before, {
    date: '2026-10-22',
    kind: 'changed',
    title: 'New',
    detail: 'y',
  });
  assert.deepEqual(validate(after, NOW), []);
  assert.equal(after.match(/date: '2026-10-22'/g).length, 1);
  assert.ok(after.indexOf('title: "New"') < after.indexOf("title: 'Old'"));
});
