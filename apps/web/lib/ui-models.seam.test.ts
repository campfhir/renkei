/**
 * The UI model seam, held statically across the web app.
 *
 * What a screen DOES — which fields a form enables, what a card adds or
 * takes off, what a list shows after a click, what request a Save sends,
 * what an error leaves on screen — lives in a `*.model.ts` beside the
 * component: a state type, an action union, a reducer, and selectors. The
 * component renders from it (`useReducer(reducer, props, init)`) and
 * dispatches what the person did and what the server answered.
 *
 * Models are tested here, in node, in milliseconds (`*.model.test.ts`),
 * and those tests are the authority on behaviour. The Playwright suite is
 * left with what only a browser can show: that the page renders, routes,
 * fits a phone, and that one path end to end reaches the server.
 *
 * So a model:
 *   - imports no React, Next, component or browser-only module, and
 *     touches no `window`, `document`, storage, timers or network — the
 *     component does that and dispatches the outcome;
 *   - has a `*.model.test.ts` beside it.
 *
 * A model that genuinely needs one of these goes in ALLOWED with the
 * reason, not around this test.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const WEB = join(__dirname, '..');

/** Web-relative model paths excused from a rule below, and why. */
const ALLOWED: Record<string, string> = {};

const FORBIDDEN: [RegExp, string][] = [
  [/from\s+['"](react|react-dom)(\/[^'"]*)?['"]/, 'an import of React'],
  [/from\s+['"]next(\/[^'"]*)?['"]/, 'an import of Next'],
  [/from\s+['"]@\/components(\/[^'"]*)?['"]/, 'an import of a component'],
  [/from\s+['"][^'"]+\.tsx['"]/, 'an import of a .tsx module'],
  [/from\s+['"]@renkei\/db['"]/, 'an import of the data store'],
  [/\b(window|document|navigator|localStorage|sessionStorage)\s*[.[]/, 'a browser global'],
  [/\bfetch\s*\(/, 'a network call'],
  [/\b(setTimeout|setInterval|requestAnimationFrame)\s*\(/, 'a timer'],
  [/\bDate\.now\s*\(|\bnew Date\s*\(\s*\)/, 'the clock (pass the time in an action)'],
  [/\bMath\.random\s*\(|\brandomUUID\s*\(/, 'randomness (pass ids in an action)'],
];

const SKIPPED_DIRS = new Set(['node_modules', '.next', 'e2e', 'test-results', 'coverage']);

function models(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) return [];
    const child = join(dir, entry.name);
    if (entry.isDirectory()) return models(child);
    return entry.name.endsWith('.model.ts') ? [child] : [];
  });
}

const found = models(WEB).map((path) => relative(WEB, path).split(sep).join('/'));

/** A comment's text is prose, not code: `window.` in a doc comment is fine. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('UI models', () => {
  it('exist (the scan found the convention in use)', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it.each(found)('%s is pure', (path) => {
    if (ALLOWED[path]) return;
    const source = code(readFileSync(join(WEB, path), 'utf8'));
    const broken = FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(([, what]) => what);
    expect(broken).toEqual([]);
  });

  it.each(found)('%s has a test beside it', (path) => {
    if (ALLOWED[path]) return;
    expect(existsSync(join(WEB, path.replace(/\.model\.ts$/, '.model.test.ts')))).toBe(true);
  });
});
