#!/usr/bin/env node
/**
 * The changelog guard: keeps apps/web/lib/changelog.ts current and well-formed.
 *
 *   node scripts/changelog.mjs check [base] [head]
 *     Fails when the changelog is malformed, or when a range of commits
 *     changes the product (apps/, packages/, docker/) without touching the
 *     changelog. CI runs this on every pull request with the PR's base and
 *     head. A commit whose message has a line `Changelog: none` opts its
 *     change out, for work nobody using Renkei would notice.
 *
 *   node scripts/changelog.mjs add --kind added|changed|fixed --title "…" --detail "…"
 *     Adds an entry at the top of today's release, or a new release for today
 *     when there is none. The date is stamped here, as the work lands; it is
 *     never typed by hand.
 *
 * The file is read through the TypeScript parser, not executed, so this runs
 * on any Node that can install the workspace, and a malformed entry is
 * reported with its line rather than as a runtime throw.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const CHANGELOG_PATH = 'apps/web/lib/changelog.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KINDS = new Set(['added', 'changed', 'fixed']);
const PRODUCT_DIRS = /^(apps|packages|docker)\//;
const NOT_PRODUCT = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\/(e2e|__tests__|scripts)\//,
  /\.md$/,
  /^apps\/web\/lib\/changelog\.ts$/,
];
const OPT_OUT = /^Changelog: none\s*$/m;

/** Whether a changed path is product code a Renkei user could notice. */
export function isProductPath(file) {
  return PRODUCT_DIRS.test(file) && !NOT_PRODUCT.some((pattern) => pattern.test(file));
}

/** Whether any commit message in the range opts out with `Changelog: none`. */
export function optsOut(commitMessages) {
  return commitMessages.some((message) => OPT_OUT.test(message));
}

function parse(source) {
  return ts.createSourceFile(CHANGELOG_PATH, source, ts.ScriptTarget.Latest, true);
}

/** The CHANGELOG array literal, or undefined when the file does not declare one. */
function findReleases(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(sourceFile) !== 'CHANGELOG') continue;
      const initializer = declaration.initializer;
      if (initializer && ts.isArrayLiteralExpression(initializer)) return initializer;
    }
  }
  return undefined;
}

/** The value node of `name: value` inside an object literal, or undefined. */
function valueOf(object, name) {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === name) {
      return property.initializer;
    }
  }
  return undefined;
}

/** The text of a plain string literal node, or undefined for anything else (null included). */
function textOf(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** Local calendar date as YYYY-MM-DD: the day the work lands on the machine doing the add. */
function localToday() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Every problem with the changelog's shape, as `file:line: message` strings.
 * Empty when the file is well-formed. The date rules are the point: each
 * release must carry a real ISO date, never null, and releases run newest first.
 */
export function validate(source, now = new Date()) {
  const sourceFile = parse(source);
  const releases = findReleases(sourceFile);
  if (!releases) return [`${CHANGELOG_PATH}: no CHANGELOG array found`];

  const where = (node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${CHANGELOG_PATH}:${line + 1}`;
  };
  // A release may be dated a day ahead of UTC: the machine adding it can be east of Greenwich.
  const latest = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const problems = [];
  let previous;

  for (const release of releases.elements) {
    if (!ts.isObjectLiteralExpression(release)) {
      problems.push(`${where(release)}: a release must be an object literal`);
      continue;
    }

    const dateNode = valueOf(release, 'date');
    const date = textOf(dateNode);
    if (date === undefined) {
      problems.push(
        `${where(release)}: date must be an ISO string such as '2026-10-22'; null and missing dates are not allowed`
      );
    } else if (!isCalendarDate(date)) {
      problems.push(`${where(dateNode)}: '${date}' is not a real YYYY-MM-DD date`);
    } else {
      if (date > latest) problems.push(`${where(dateNode)}: '${date}' is in the future`);
      if (previous !== undefined && date > previous) {
        problems.push(
          `${where(dateNode)}: '${date}' comes after '${previous}'; releases run newest first`
        );
      }
      previous = date;
    }

    const heading = valueOf(release, 'heading');
    if (heading !== undefined && textOf(heading) === undefined) {
      problems.push(`${where(heading)}: heading must be a string`);
    }

    const entries = valueOf(release, 'entries');
    if (!entries || !ts.isArrayLiteralExpression(entries) || entries.elements.length === 0) {
      problems.push(`${where(release)}: entries must be a non-empty array`);
      continue;
    }
    for (const entry of entries.elements) {
      if (!ts.isObjectLiteralExpression(entry)) {
        problems.push(`${where(entry)}: an entry must be an object literal`);
        continue;
      }
      const kind = textOf(valueOf(entry, 'kind'));
      if (!KINDS.has(kind)) {
        problems.push(`${where(entry)}: kind must be one of ${[...KINDS].join(', ')}`);
      }
      for (const field of ['title', 'detail']) {
        const text = textOf(valueOf(entry, field));
        if (!text || !text.trim()) {
          problems.push(`${where(entry)}: ${field} must be a non-empty string`);
        }
      }
    }
  }
  return problems;
}

const quote = (text) => JSON.stringify(text);

/**
 * The changelog source with one entry added under `date`. If the first release
 * is already dated `date`, the entry leads that release; otherwise a new release
 * is opened at the top. Pure: the caller writes the file.
 */
export function addEntry(source, { date, kind, title, detail }) {
  const sourceFile = parse(source);
  const releases = findReleases(sourceFile);
  if (!releases) throw new Error(`${CHANGELOG_PATH}: no CHANGELOG array found`);

  const entry = `{\n  kind: ${quote(kind)},\n  title: ${quote(title)},\n  detail: ${quote(detail)},\n}`;
  const first = releases.elements[0];
  const firstEntries =
    first && ts.isObjectLiteralExpression(first) ? valueOf(first, 'entries') : undefined;

  if (first && textOf(valueOf(first, 'date')) === date && firstEntries) {
    const at = firstEntries.getStart(sourceFile) + 1;
    return `${source.slice(0, at)}\n${entry},${source.slice(at)}`;
  }
  const at = releases.getStart(sourceFile) + 1;
  const release = `{\n  date: '${date}',\n  entries: [\n${entry},\n],\n}`;
  return `${source.slice(0, at)}\n${release},${source.slice(at)}`;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function check(base, head) {
  const files = git(['diff', '--name-only', `${base}...${head}`])
    .split('\n')
    .filter(Boolean);
  const messages = git(['log', '--format=%B%x00', `${base}..${head}`])
    .split('\0')
    .filter((message) => message.trim());
  const source = git(['show', `${head}:${CHANGELOG_PATH}`]);

  const problems = validate(source);
  const product = files.filter(isProductPath);
  if (product.length > 0 && !files.includes(CHANGELOG_PATH) && !optsOut(messages)) {
    problems.push(
      [
        `${product.length} product file(s) changed with no entry in ${CHANGELOG_PATH}:`,
        ...product.slice(0, 10).map((file) => `  ${file}`),
        product.length > 10 ? `  …and ${product.length - 10} more` : undefined,
        'Add one with: pnpm changelog add --kind <added|changed|fixed> --title "…" --detail "…"',
        'If nobody using Renkei would notice the change, put `Changelog: none` on its own line in a commit message.',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`changelog ok (${files.length} file(s) compared, ${messages.length} commit(s))`);
  }
}

function add(options) {
  for (const field of ['kind', 'title', 'detail']) {
    if (!options[field] || !options[field].trim()) throw new Error(`--${field} is required`);
  }
  if (!KINDS.has(options.kind)) throw new Error(`--kind must be one of ${[...KINDS].join(', ')}`);

  const file = path.join(ROOT, CHANGELOG_PATH);
  const before = readFileSync(file, 'utf8');
  const existing = validate(before);
  if (existing.length > 0) throw new Error(`fix the changelog first:\n${existing.join('\n')}`);

  const date = localToday();
  writeFileSync(file, addEntry(before, { ...options, date }));
  execFileSync(path.join(ROOT, 'node_modules/.bin/prettier'), ['--write', file], { cwd: ROOT });

  const after = validate(readFileSync(file, 'utf8'));
  if (after.length > 0) throw new Error(`the added entry did not validate:\n${after.join('\n')}`);
  console.log(`added ${options.kind} entry dated ${date} to ${CHANGELOG_PATH}`);
}

function parseFlags(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!name.startsWith('--')) throw new Error(`unexpected argument ${name}`);
    options[name.slice(2)] = args[i + 1];
  }
  return options;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'check') {
    const [base = 'origin/main', head = 'HEAD'] = rest;
    return check(base, head);
  }
  if (command === 'add') return add(parseFlags(rest));
  console.error(
    'usage: changelog.mjs check [base] [head] | add --kind <kind> --title <t> --detail <d>'
  );
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
