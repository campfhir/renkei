import { diffTotals, parseUnifiedDiff, sideBySideRows, splitDiffResult } from './diff';

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@ export function main() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a + b;
 }
`;

const ADDED = `diff --git a/docs/notes.md b/docs/notes.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/docs/notes.md
@@ -0,0 +1,2 @@
+# Notes
+hello
`;

const UNTRACKED = `diff --git a/dev/null b/README.md
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/README.md
@@ -0,0 +1 @@
+# Readme
\\ No newline at end of file
`;

describe('parseUnifiedDiff', () => {
  it('reads a modified file with numbers on both sides', () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    expect(file).toMatchObject({
      path: 'src/app.ts',
      status: 'modified',
      added: 2,
      deleted: 1,
    });
    const hunk = file!.hunks[0]!;
    expect(hunk.heading).toBe('export function main() {');
    expect(hunk.lines.map((line) => [line.kind, line.oldNo ?? null, line.newNo ?? null])).toEqual([
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
      ['context', 4, 5],
    ]);
  });

  it('reads several files, new ones as added, no-newline notes skipped', () => {
    const files = parseUnifiedDiff(MODIFIED + ADDED + UNTRACKED);
    expect(files.map((file) => [file.path, file.status])).toEqual([
      ['src/app.ts', 'modified'],
      ['docs/notes.md', 'added'],
      ['README.md', 'added'],
    ]);
    expect(files[2]!.hunks[0]!.lines).toEqual([{ kind: 'add', text: '# Readme', newNo: 1 }]);
    expect(diffTotals(files)).toEqual({ added: 5, deleted: 1 });
  });

  it('marks binary files and renames', () => {
    const files = parseUnifiedDiff(
      'diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n' +
        'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n'
    );
    expect(files.map((file) => [file.path, file.status])).toEqual([
      ['logo.png', 'binary'],
      ['new.ts', 'renamed'],
    ]);
  });
});

describe('sideBySideRows', () => {
  it('pairs a deletion run with the additions after it', () => {
    const [file] = parseUnifiedDiff(MODIFIED);
    const rows = sideBySideRows(file!.hunks[0]!);
    expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ['const a = 1;', 'const a = 1;'],
      ['const b = 2;', 'const b = 3;'],
      [null, 'const c = 4;'],
      ['return a + b;', 'return a + b;'],
      ['}', '}'],
    ]);
  });
});

describe('splitDiffResult', () => {
  it('separates the prose from the fenced diff', () => {
    expect(splitDiffResult(`Edited x (1 replacement).\n\n\`\`\`diff\n${MODIFIED}\n\`\`\``)).toEqual(
      {
        text: 'Edited x (1 replacement).',
        diff: MODIFIED,
      }
    );
    expect(splitDiffResult('plain')).toEqual({ text: 'plain', diff: null });
  });
});
