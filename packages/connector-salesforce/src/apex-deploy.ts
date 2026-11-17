/**
 * Deploying Apex: what a change carries, and what has to be true of its
 * tests before it may deploy.
 *
 * Apex is written in a code project's repository in the Salesforce DX
 * layout (`force-app/main/default/classes/Foo.cls` beside
 * `Foo.cls-meta.xml`; `triggers/…` the same) and goes to an org as a
 * Metadata API package (`classes/Foo.cls`, `package.xml`), through the
 * same change requests as the rest of an org's setup.
 *
 * Every Apex change runs tests, in a sandbox as in production: the named
 * test classes (`RunSpecifiedTests`), and it may deploy only when every
 * test passed and each class and trigger it changes is at least
 * APEX_COVERAGE_PERCENT covered — stricter than Salesforce's own 75%
 * across the org, and asked of sandboxes too, where Salesforce asks
 * nothing.
 *
 * Taking Apex out: a trigger is switched off (deployed with status
 * Inactive), which production allows and which keeps its source in the
 * org; a class cannot be switched off in production, so it is deleted
 * (`destructiveChangesPost.xml`, after the rest of the package, so a
 * change that also takes the last reference out deploys together). The
 * repository keeps its source either way.
 */

import { METADATA_NAMESPACE, packageXml, xmlEscape, type PackageMember } from './metadata';
import { SALESFORCE_API_VERSION } from './api';
import type { ApexKind, ApexUnit } from './apex';

/** Where a Salesforce DX project keeps its source when nothing says otherwise. */
export const SFDX_SOURCE_ROOT = 'force-app/main/default';

const FOLDER: Record<ApexKind, string> = { class: 'classes', trigger: 'triggers' };
const SUFFIX: Record<ApexKind, string> = { class: 'cls', trigger: 'trigger' };
const TYPE: Record<ApexKind, 'ApexClass' | 'ApexTrigger'> = {
  class: 'ApexClass',
  trigger: 'ApexTrigger',
};

/** The repository path a class or trigger is written to, under `root`. */
export function apexSourcePath(unit: ApexUnit, root = SFDX_SOURCE_ROOT): string {
  return `${root}/${FOLDER[unit.kind]}/${unit.name}.${SUFFIX[unit.kind]}`;
}

/**
 * The class or trigger a repository path holds (any package directory:
 * `…/classes/Foo.cls`, `…/triggers/Bar.trigger`), with whether it is the
 * source or its `-meta.xml`; null for anything else.
 */
export function apexUnitOfPath(path: string): (ApexUnit & { meta: boolean }) | null {
  const match =
    /(?:^|\/)(classes|triggers)\/([A-Za-z][A-Za-z0-9_]*)\.(cls|trigger)(-meta\.xml)?$/.exec(path);
  if (!match) return null;
  const kind: ApexKind = match[1] === 'classes' ? 'class' : 'trigger';
  if (match[3] !== SUFFIX[kind]) return null;
  return { kind, name: match[2], meta: Boolean(match[4]) };
}

export type ApexStatus = 'Active' | 'Inactive';

/** A class's or trigger's `-meta.xml`. */
export function apexMetaXml(
  kind: ApexKind,
  apiVersion: string,
  status: ApexStatus = 'Active'
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<${TYPE[kind]} xmlns="${METADATA_NAMESPACE}">\n` +
    `    <apiVersion>${xmlEscape(apiVersion)}</apiVersion>\n` +
    `    <status>${status}</status>\n</${TYPE[kind]}>\n`
  );
}

/** The API version and status a `-meta.xml` names; the defaults where it names none. */
export function readApexMeta(xml: string): { apiVersion: string; status: ApexStatus } {
  const version = /<apiVersion>\s*([\d.]+)\s*<\/apiVersion>/.exec(xml)?.[1];
  const status = /<status>\s*(\w+)\s*<\/status>/.exec(xml)?.[1];
  return {
    apiVersion: version ?? SALESFORCE_API_VERSION,
    status: status === 'Inactive' ? 'Inactive' : 'Active',
  };
}

/** Comments and string literals out, so an annotation in either is not read as one. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

/**
 * Whether a class is a test class: `@isTest` before its first `class`
 * keyword. Test classes are run, never measured for coverage.
 */
export function isTestClass(source: string): boolean {
  const code = codeOnly(source);
  const classAt = code.search(/\bclass\b/i);
  const head = classAt === -1 ? code : code.slice(0, classAt);
  return /@isTest\b/i.test(head);
}

export interface ApexUpsert extends ApexUnit {
  body: string;
  apiVersion: string;
  status?: ApexStatus;
}

/**
 * The Metadata API package for these classes and triggers written (each
 * with its `-meta.xml`) and these deleted, after the rest deploys.
 */
export function apexPackage(input: {
  upserts: readonly ApexUpsert[];
  deletes?: readonly ApexUnit[];
}): { files: Record<string, string>; members: PackageMember[] } {
  const files: Record<string, string> = {};
  const members: PackageMember[] = [];
  for (const unit of input.upserts) {
    const path = `${FOLDER[unit.kind]}/${unit.name}.${SUFFIX[unit.kind]}`;
    files[path] = unit.body;
    files[`${path}-meta.xml`] = apexMetaXml(unit.kind, unit.apiVersion, unit.status);
    members.push({ type: TYPE[unit.kind], member: unit.name });
  }
  files['package.xml'] = packageXml(members);
  const deletes = input.deletes ?? [];
  if (deletes.length > 0) {
    files['destructiveChangesPost.xml'] = packageXml(
      deletes.map((unit) => ({ type: TYPE[unit.kind], member: unit.name }))
    );
  }
  return { files, members };
}

// ——— a line diff, for the review page ———

export type DiffLine = { op: ' ' | '-' | '+'; text: string };

/** Past this many changed lines a diff is shown as the old source out and the new in. */
const DIFF_EDIT_LIMIT = 4_000;

/**
 * The lines that turn `before` into `after` (Myers' shortest edit
 * script), every line kept: `' '` unchanged, `'-'` removed, `'+'` added.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split(/\r\n|\r|\n/);
  const b = after === '' ? [] : after.split(/\r\n|\r|\n/);
  // Common ends first: most edits touch a small middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const keep = (lines: string[]): DiffLine[] => lines.map((line) => ({ op: ' ', text: line }));
  return [...keep(a.slice(0, head)), ...middleDiff(x, y), ...keep(a.slice(a.length - tail))];
}

function middleDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const replaceAll = (): DiffLine[] => [
    ...a.map((line) => ({ op: '-' as const, text: line })),
    ...b.map((line) => ({ op: '+' as const, text: line })),
  ];
  if (n === 0 || m === 0) return replaceAll();
  const max = Math.min(n + m, DIFF_EDIT_LIMIT);
  const offset = max;
  const v = new Array<number>(2 * max + 2).fill(0);
  const trace: number[][] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let xi =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let yi = xi - k;
      while (xi < n && yi < m && a[xi] === b[yi]) {
        xi += 1;
        yi += 1;
      }
      v[offset + k] = xi;
      if (xi >= n && yi >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return replaceAll();
  // Walk the trace back from the end.
  const out: DiffLine[] = [];
  let xi = n;
  let yi = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const prev = trace[d];
    const k = xi - yi;
    const down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (xi > prevX && yi > prevY) {
      out.push({ op: ' ', text: a[xi - 1] });
      xi -= 1;
      yi -= 1;
    }
    if (down) out.push({ op: '+', text: b[yi - 1] });
    else out.push({ op: '-', text: a[xi - 1] });
    xi = prevX;
    yi = prevY;
  }
  while (xi > 0 && yi > 0) {
    out.push({ op: ' ', text: a[xi - 1] });
    xi -= 1;
    yi -= 1;
  }
  return out.reverse();
}

/**
 * A diff cut to what changed and `context` lines around it, as unified
 * text (`@@ -12,4 +12,6 @@`); empty when nothing changed.
 */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const lines = lineDiff(before, after);
  const changed = lines.map((line) => line.op !== ' ');
  if (!changed.some(Boolean)) return '';
  const out: string[] = [];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  const advance = (line: DiffLine) => {
    if (line.op !== '+') oldLine += 1;
    if (line.op !== '-') newLine += 1;
  };
  while (i < lines.length) {
    const next = changed.indexOf(true, i);
    if (next === -1) break;
    const start = Math.max(i, next - context);
    for (; i < start; i += 1) advance(lines[i]);
    // Extend the hunk while changes come within 2 × context of each other.
    let end = next;
    for (let j = next; j < lines.length; j += 1) {
      if (changed[j]) end = j;
      else if (j - end > context * 2) break;
    }
    const stop = Math.min(lines.length, end + context + 1);
    const hunk = lines.slice(start, stop);
    const oldCount = hunk.filter((line) => line.op !== '+').length;
    const newCount = hunk.filter((line) => line.op !== '-').length;
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (const line of hunk) {
      out.push(`${line.op}${line.text}`);
      advance(line);
    }
    i = stop;
  }
  return out.join('\n');
}

export { TYPE as APEX_METADATA_TYPE };
