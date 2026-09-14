/**
 * A unified diff, read: what git prints (`git diff`, one or many files,
 * untracked files diffed against /dev/null) turned into files, hunks and
 * lines with their numbers on both sides — the shape the page renders
 * side by side or stacked, and the chat folds per file. Pure; no DOM.
 */

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the old file; absent on an added line. */
  oldNo?: number;
  /** Line number in the new file; absent on a deleted line. */
  newNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** What followed the @@ … @@ — the enclosing function, when git found one. */
  heading: string;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';

export interface DiffFile {
  /** The path to show: the new one, or the old one for a deletion. */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: DiffFileStatus;
  hunks: DiffHunk[];
  added: number;
  deleted: number;
}

/** A side-by-side row: an old line, a new line, or one of each paired. */
export interface DiffRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

function stripPrefix(path: string): string | null {
  if (path === '/dev/null') return null;
  // git writes a/x and b/x; `--no-index` against /dev/null writes the bare path.
  return path.replace(/^[ab]\//, '');
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      file = {
        path: '',
        oldPath: null,
        newPath: null,
        status: 'modified',
        hunks: [],
        added: 0,
        deleted: 0,
      };
      files.push(file);
      hunk = null;
      // `diff --git a/x b/x` names both sides; the --- / +++ lines refine them.
      const named = /^diff --git (?:a\/)?(.+?) (?:b\/)?(.+)$/.exec(line);
      if (named) file.path = named[2] ?? named[1] ?? '';
      continue;
    }
    if (!file) continue;
    if (hunk === null) {
      if (line.startsWith('--- ')) {
        file.oldPath = stripPrefix(line.slice(4).replace(/\t.*$/, ''));
        continue;
      }
      if (line.startsWith('+++ ')) {
        file.newPath = stripPrefix(line.slice(4).replace(/\t.*$/, ''));
        file.path = file.newPath ?? file.oldPath ?? file.path;
        if (file.oldPath === null) file.status = 'added';
        else if (file.newPath === null) file.status = 'deleted';
        else if (file.oldPath !== file.newPath) file.status = 'renamed';
        continue;
      }
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.oldPath = line.slice('rename from '.length);
        file.status = 'renamed';
      } else if (line.startsWith('rename to ')) {
        file.newPath = line.slice('rename to '.length);
        file.path = file.newPath;
      } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        file.status = 'binary';
      }
    }
    const header = HUNK.exec(line);
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        heading: header[5] ?? '',
        lines: [],
      };
      file.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;
    const mark = line[0];
    const body = line.slice(1);
    if (mark === '+') {
      hunk.lines.push({ kind: 'add', text: body, newNo });
      newNo += 1;
      file.added += 1;
    } else if (mark === '-') {
      hunk.lines.push({ kind: 'del', text: body, oldNo });
      oldNo += 1;
      file.deleted += 1;
    } else if (mark === ' ' || line === '') {
      // A trailing empty string is the split's artefact after the final
      // newline; inside a hunk an empty line is a context line of nothing.
      const complete =
        oldNo - hunk.oldStart >= hunk.oldLines && newNo - hunk.newStart >= hunk.newLines;
      if (line === '' && complete) continue;
      hunk.lines.push({ kind: 'context', text: body, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    } else {
      // Anything else ends the hunk (a new file header follows).
      hunk = null;
    }
  }
  return files;
}

/**
 * A hunk's lines as side-by-side rows: context on both sides, a run of
 * deletions paired with the run of additions that follows it, and the
 * longer run's tail against an empty cell.
 */
export function sideBySideRows(hunk: DiffHunk): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;
  const { lines } = hunk;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (index < lines.length && lines[index]!.kind === 'del') dels.push(lines[index++]!);
    while (index < lines.length && lines[index]!.kind === 'add') adds.push(lines[index++]!);
    const length = Math.max(dels.length, adds.length);
    for (let row = 0; row < length; row += 1) {
      rows.push({ left: dels[row] ?? null, right: adds[row] ?? null });
    }
  }
  return rows;
}

/** Totals over parsed files. */
export function diffTotals(files: DiffFile[]): { added: number; deleted: number } {
  return files.reduce(
    (sum, file) => ({ added: sum.added + file.added, deleted: sum.deleted + file.deleted }),
    { added: 0, deleted: 0 }
  );
}

/** The fence a code_* tool result carries its diff in, for the chat to render. */
export const DIFF_FENCE_OPEN = '```diff\n';
export const DIFF_FENCE_CLOSE = '\n```';

/** Splits a tool result into its prose and the fenced diff, if it carries one. */
export function splitDiffResult(content: string): { text: string; diff: string | null } {
  const start = content.indexOf(DIFF_FENCE_OPEN);
  if (start < 0) return { text: content, diff: null };
  const bodyStart = start + DIFF_FENCE_OPEN.length;
  const end = content.lastIndexOf(DIFF_FENCE_CLOSE);
  const body = end > bodyStart ? content.slice(bodyStart, end) : content.slice(bodyStart);
  return { text: content.slice(0, start).replace(/\s+$/, ''), diff: body };
}
