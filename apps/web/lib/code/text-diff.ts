/**
 * A unified diff between two texts, made in the browser — for the code
 * pane's Compare, where the checkout's file and the person's unsaved
 * edits are both already here and nothing on the worker has seen the
 * edits. Myers' shortest-edit-script over lines, the diff `git` prints
 * by default, so `lib/code/diff.ts` parses the result and the thread's
 * DiffView draws it. Bounded: past `MAX_LINES` on either side the answer
 * is null and the caller shows the two texts instead.
 */

export const MAX_LINES = 20_000;

type Op = { kind: 'eq' | 'del' | 'add'; line: string };

function edits(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (n > MAX_LINES || m > MAX_LINES) return null;
  // Myers, with the V arrays of every step kept for the backtrack.
  const offset = max;
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 2);
  v[offset + 1] = 0;
  outer: for (let d = 0; d <= max; d += 1) {
    trace.push(v);
    const next = new Int32Array(v);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        v = next;
        trace.push(v);
        break outer;
      }
    }
    v = next;
  }
  // Backtrack from the end.
  const out: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d -= 1) {
    const step = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && step[offset + k - 1] < step[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = step[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      out.push({ kind: 'eq', line: a[x] });
    }
    if (d > 0) {
      if (x === prevX) {
        y -= 1;
        out.push({ kind: 'add', line: b[y] });
      } else {
        x -= 1;
        out.push({ kind: 'del', line: a[x] });
      }
    }
  }
  return out.reverse();
}

/**
 * The unified diff of `before` → `after`, named `path`, with `context`
 * lines around each change; an empty string when they are the same,
 * null when either is past the bound.
 */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  context = 3
): string | null {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  const ops = edits(a, b);
  if (!ops) return null;
  const lines: string[] = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  // Group ops into hunks: a change plus `context` equal lines around it.
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < ops.length) {
    if (ops[i].kind === 'eq') {
      i += 1;
      oldLine += 1;
      newLine += 1;
      continue;
    }
    // Hunk starts `context` lines before this change.
    const start = Math.max(0, i - context);
    let end = i;
    // Extend through changes separated by at most 2*context equal lines.
    let j = i;
    while (j < ops.length) {
      if (ops[j].kind !== 'eq') {
        end = j + 1;
        j += 1;
        continue;
      }
      let run = 0;
      while (j + run < ops.length && ops[j + run].kind === 'eq') run += 1;
      if (run > 2 * context || j + run >= ops.length) break;
      j += run;
    }
    const tail = Math.min(ops.length, end + context);
    const skippedBefore = i - start;
    const hunkOldStart = oldLine - skippedBefore;
    const hunkNewStart = newLine - skippedBefore;
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let k = start; k < tail; k += 1) {
      const op = ops[k];
      if (op.kind === 'eq') {
        body.push(` ${op.line}`);
        oldCount += 1;
        newCount += 1;
      } else if (op.kind === 'del') {
        body.push(`-${op.line}`);
        oldCount += 1;
      } else {
        body.push(`+${op.line}`);
        newCount += 1;
      }
    }
    lines.push(`@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@`, ...body);
    // Advance the counters past the hunk.
    for (let k = i; k < tail; k += 1) {
      const op = ops[k];
      if (op.kind === 'eq') {
        oldLine += 1;
        newLine += 1;
      } else if (op.kind === 'del') oldLine += 1;
      else newLine += 1;
    }
    i = tail;
  }
  return lines.join('\n') + '\n';
}
