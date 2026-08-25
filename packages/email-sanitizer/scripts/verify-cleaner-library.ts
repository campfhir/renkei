/**
 * Ad-hoc: prove every script in the cleaner library still does what the
 * deleted built-in did.
 *
 * These scripts replace heuristics that used to live in `clean/generic.ts`
 * and `clean/calendar.ts`. The cases under `cleaner-library/cases/` are the
 * original fixtures from that code, recovered verbatim — so a pass here
 * means the script reproduces the removed behaviour exactly, not merely
 * something similar.
 *
 * It runs them through `runCleanerScript`, the real QuickJS sandbox with
 * the real limits, because that is the only way to catch the failures that
 * matter: source that does not parse as a function, a regex that is fine in
 * Node and absent in QuickJS, or a script that runs past the 250ms budget
 * on a long body. A script that passes here can be pasted into the admin
 * page and will behave the same way.
 *
 *   pnpm --filter @renkei/email-sanitizer verify:cleaners
 *
 * No database, no network, no tenant — nothing is installed by running it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCleanerScript, validateCleanerScriptSource, compileCleanerScript } from '../src/index';
import type { CleanerScriptKind } from '../src/index';

// The package is ESM ("type": "module"), so there is no __dirname.
const HERE = dirname(fileURLToPath(import.meta.url));
const LIBRARY = join(HERE, 'cleaner-library');
const CASES = join(LIBRARY, 'cases');

interface Case {
  script: string;
  kind: CleanerScriptKind;
  description: string;
  content: string;
  expected: string;
}

function isKind(value: unknown): value is CleanerScriptKind {
  return value === 'msg' || value === 'evt' || value === 'task';
}

/** A parsed case file, or a clear error naming the file that is wrong. */
function isCase(value: unknown): value is Case {
  if (typeof value !== 'object' || value === null) return false;
  const record: Record<string, unknown> = { ...value };
  return (
    typeof record.script === 'string' &&
    isKind(record.kind) &&
    typeof record.description === 'string' &&
    typeof record.content === 'string' &&
    typeof record.expected === 'string'
  );
}

function loadCases(): Case[] {
  return readdirSync(CASES)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const parsed: unknown = JSON.parse(readFileSync(join(CASES, file), 'utf8'));
      if (!isCase(parsed)) {
        throw new Error(
          `${file} is not a valid case (script, kind, description, content, expected)`
        );
      }
      return parsed;
    });
}

/**
 * A body far longer than any real message, built from the shapes each
 * script actually scans for.
 *
 * The budget is the failure mode these fixtures cannot show: every case
 * above is a few lines, so a script that backtracks badly still passes them
 * and then times out on a real forwarded thread. A timeout in production is
 * a recorded no-op — the message indexes UNCLEANED and the only trace is a
 * last_error on a row nobody is watching — so it is worth proving here.
 */
function stressBody(): string {
  const block = [
    'Thanks for the update, I will take a look today and come back to you.',
    'Microsoft Teams',
    'Need help?',
    'Meeting ID: 231 998 447 102',
    'For organizers: Meeting options | Reset dial-in PIN',
    'On Mon, Jan 5, 2026 at 9:00 AM Bob Smith <bob@example.com> wrote:',
    '> quoted line that goes on for a while to make the scan do real work',
    '________________________________________________________________________',
  ];
  const lines: string[] = [];
  for (let i = 0; i < 1_500; i += 1) lines.push(block[i % block.length]);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const scripts = readdirSync(LIBRARY).filter((file) => file.endsWith('.ts'));
  const cases = loadCases();
  let failures = 0;

  for (const name of scripts) {
    const written = readFileSync(join(LIBRARY, name), 'utf8');
    console.log(`\n${name}`);

    // The library is TypeScript, and QuickJS is not. Everything below runs
    // the STRIPPED output, which is what the save route stores and what
    // production actually executes — verifying the annotated source would
    // be verifying something no sandbox ever sees.
    const built = await compileCleanerScript(written);
    if (!built.ok) {
      console.log(`  ✗ does not compile — ${built.detail ?? built.err.type}`);
      failures += 1;
      continue;
    }
    const source = built.val.compiled;
    console.log('  ✓ compiles (types stripped)');

    // Save-time check first: the admin page refuses a script that is not a
    // function expression, so a library entry that would be rejected there
    // must be caught here rather than at paste time.
    const valid = await validateCleanerScriptSource(source);
    if (!valid.ok) {
      console.log(`  ✗ does not parse as a function — ${valid.error}`);
      failures += 1;
      continue;
    }
    console.log('  ✓ parses as (email) => string');

    const mine = cases.filter((entry) => entry.script === name);
    if (mine.length === 0) {
      // Not fatal, but worth saying out loud: an unverified script in a
      // library implies a guarantee the library is not making.
      console.log('  ! no cases cover this script');
      continue;
    }

    for (const entry of mine) {
      const run = await runCleanerScript(source, {
        text: entry.content,
        kind: entry.kind,
        subject: '(verification)',
        fromAddress: 'verify@example.com',
        fromName: 'Verify',
      });
      if (!run.ok) {
        console.log(`  ✗ ${entry.description}\n      ${run.err.type}: ${run.detail ?? ''}`);
        failures += 1;
        continue;
      }
      if (run.val !== entry.expected) {
        console.log(`  ✗ ${entry.description}`);
        console.log(`      expected: ${JSON.stringify(entry.expected)}`);
        console.log(`      actual:   ${JSON.stringify(run.val)}`);
        failures += 1;
        continue;
      }
      console.log(`  ✓ ${entry.description}`);
    }

    const stress = await runCleanerScript(source, {
      text: stressBody(),
      kind: mine[0].kind,
      subject: '(stress)',
      fromAddress: 'verify@example.com',
      fromName: 'Verify',
    });
    if (stress.ok) {
      console.log(`  ✓ finishes inside the budget on a ${stressBody().length}-char body`);
    } else {
      console.log(`  ✗ budget: ${stress.err.type} — ${stress.detail ?? ''}`);
      failures += 1;
    }
  }

  console.log(
    failures === 0
      ? `\nAll ${cases.length} cases passed across ${scripts.length} scripts.`
      : `\n${failures} failure(s).`
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
