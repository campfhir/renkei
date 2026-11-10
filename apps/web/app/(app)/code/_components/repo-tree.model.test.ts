/**
 * The code pane's file tree (repo-tree.model.ts), as a person using it
 * would describe it. What the server does with a create — a trailing "/"
 * makes a folder, a nested path makes its parents — is the files route's
 * test (app/api/code/projects/[projectId]/files/route.test.ts). The
 * browser spec (code-file-management.spec.ts) keeps one create, a deleted
 * file's ghost opening its diff, and the dimming as drawn.
 */

import {
  canDownload,
  canMoveInto,
  canWrite,
  deletePrompt,
  downloadLink,
  dropUpload,
  ghostsFor,
  initialTree,
  markTitle,
  moveRequest,
  rowIgnored,
  rowMenu,
  sizeLabel,
  submission,
  toggleReads,
  treeReducer,
  type Entry,
  type FileMark,
  type TreeAction,
  type TreeState,
} from './repo-tree.model';

const run = (actions: TreeAction[], from: TreeState = initialTree) =>
  actions.reduce(treeReducer, from);

const file = (path: string, more: Partial<Entry> = {}): Entry => ({
  path,
  kind: 'file',
  sizeBytes: 10,
  ...more,
});

const checkout = run([
  { type: 'listed', path: '', entries: [file('README.md')], source: 'checkout' },
]);

describe('listing folders', () => {
  it('shows a loading line, then the entries, and remembers where they came from', () => {
    const loading = run([{ type: 'loading', path: 'src' }]);
    expect(loading.listings.src).toEqual({ state: 'loading' });
    const listed = run(
      [{ type: 'listed', path: 'src', entries: [file('src/a.ts')], source: 'bitbucket' }],
      loading
    );
    expect(listed.listings.src).toEqual({ state: 'ready', entries: [file('src/a.ts')] });
    expect(listed.source).toBe('bitbucket');
  });

  it('a folder that cannot be listed says why in its place', () => {
    const failed = run([{ type: 'listFailed', path: 'src', message: 'Not allowed' }]);
    expect(failed.listings.src).toEqual({ state: 'error', message: 'Not allowed' });
  });

  it('opening a folder reads it the first time only; closing never reads', () => {
    expect(toggleReads(initialTree, 'src')).toBe(true);
    const opened = run([
      { type: 'toggled', path: 'src' },
      { type: 'listed', path: 'src', entries: [], source: 'checkout' },
    ]);
    expect(opened.open.src).toBe(true);
    expect(toggleReads(opened, 'src')).toBe(false);
    const closed = run([{ type: 'toggled', path: 'src' }], opened);
    expect(closed.open.src).toBe(false);
    expect(toggleReads(closed, 'src')).toBe(false);
  });

  it('a file landing in a closed folder opens it; the root is always open', () => {
    expect(run([{ type: 'revealed', folder: 'docs' }]).open.docs).toBe(true);
    expect(run([{ type: 'revealed', folder: '' }])).toBe(initialTree);
  });
});

describe('who may change the tree', () => {
  it('only an editor, and only once there is a checkout (the git host’s view is read-only)', () => {
    expect(canWrite(checkout, true)).toBe(true);
    expect(canWrite(checkout, false)).toBe(false);
    const host = run([{ type: 'listed', path: '', entries: [], source: 'github' }]);
    expect(canWrite(host, true)).toBe(false);
    expect(canWrite(initialTree, true)).toBe(false);
  });

  it('anyone who sees a checkout may download from it; the git host’s view has no download', () => {
    expect(canDownload(checkout)).toBe(true);
    expect(canDownload(run([{ type: 'listed', path: '', entries: [], source: 'bitbucket' }]))).toBe(
      false
    );
  });
});

describe('the row menu', () => {
  const editor = { write: true, download: true };
  const reader = { write: false, download: true };

  it('a folder offers New file, Rename, Download as zip and Delete to an editor', () => {
    expect(rowMenu('dir', editor)).toEqual(['new-file', 'rename', 'download', 'delete']);
  });

  it('a file offers Rename, Download and Delete — no New file inside a file', () => {
    expect(rowMenu('file', editor)).toEqual(['rename', 'download', 'delete']);
  });

  it('someone who cannot edit gets Download alone', () => {
    expect(rowMenu('dir', reader)).toEqual(['download']);
    expect(rowMenu('file', reader)).toEqual(['download']);
  });

  it('no menu before a checkout, and none on a link or anything else', () => {
    expect(rowMenu('file', { write: false, download: false })).toBeNull();
    expect(rowMenu('link', editor)).toBeNull();
    expect(rowMenu('other', editor)).toBeNull();
  });

  it('a folder downloads as a zip named after it; a file as itself', () => {
    expect(downloadLink('/a/archive', 'src/lib', 'dir')).toEqual({
      label: 'Download as zip',
      href: '/a/archive?path=src%2Flib',
      filename: 'lib.zip',
    });
    expect(downloadLink('/a/archive', 'src/a b.ts', 'file')).toEqual({
      label: 'Download',
      href: '/a/archive?path=src%2Fa%20b.ts',
      filename: 'a b.ts',
    });
  });

  it('Delete asks first, and says a folder takes everything in it', () => {
    expect(deletePrompt('src/a.ts', 'file')).toBe("Delete “a.ts”? This can't be undone.");
    expect(deletePrompt('src', 'dir')).toBe(
      "Delete “src” and everything in it? This can't be undone."
    );
  });
});

describe('the New file dialog', () => {
  const named = (name: string, folder = '') =>
    run([
      { type: 'newFile', folder },
      { type: 'nameChanged', name },
    ]);

  it('opens empty, for the folder it was asked from', () => {
    expect(run([{ type: 'newFile', folder: 'src' }]).dialog).toEqual({
      kind: 'new-file',
      folder: 'src',
      name: '',
    });
  });

  it('an empty name is refused with what to do, and nothing is sent', () => {
    expect(submission(named('   ').dialog!)).toEqual({
      kind: 'refused',
      error: 'Say what to call it.',
    });
  });

  it('".." anywhere in the path is refused before any request leaves', () => {
    for (const name of ['../escape.txt', 'a/../../b', 'a/..']) {
      expect(submission(named(name).dialog!)).toEqual({
        kind: 'refused',
        error: 'A path cannot leave the workspace ("..").',
      });
    }
    // A name that merely contains dots is fine.
    expect(submission(named('..env').dialog!).kind).toBe('create');
  });

  it('creates the trimmed name under its folder', () => {
    expect(submission(named(' notes.md ').dialog!)).toEqual({
      kind: 'create',
      folder: '',
      body: { path: 'notes.md' },
    });
    expect(submission(named('util.ts', 'src').dialog!)).toEqual({
      kind: 'create',
      folder: 'src',
      body: { path: 'src/util.ts' },
    });
  });

  it('a trailing "/" and a nested path go to the server as typed — it makes the folders', () => {
    expect(submission(named('assets/').dialog!)).toMatchObject({ body: { path: 'assets/' } });
    expect(submission(named('generated/nested/deep.txt').dialog!)).toMatchObject({
      body: { path: 'generated/nested/deep.txt' },
    });
  });

  it('a refused create keeps the dialog and what was typed, and says why', () => {
    const failed = run(
      [{ type: 'sent' }, { type: 'failed', error: 'notes.md already exists.' }],
      named('notes.md')
    );
    expect(failed.dialog?.name).toBe('notes.md');
    expect(failed.busy).toBe(false);
    expect(failed.dialogError).toBe('notes.md already exists.');
  });

  it('a create that goes through closes the dialog and opens the folder it landed in', () => {
    const done = run([{ type: 'sent' }, { type: 'done', folder: 'src' }], named('a.ts', 'src'));
    expect(done.dialog).toBeNull();
    expect(done.busy).toBe(false);
    expect(done.open.src).toBe(true);
  });

  it('opening the dialog again forgets the last error', () => {
    const refused = run([{ type: 'refused', error: 'Say what to call it.' }], named(''));
    expect(run([{ type: 'newFile', folder: '' }], refused).dialogError).toBeNull();
  });
});

describe('the Rename dialog', () => {
  const renaming = (path: string, name?: string) =>
    run([
      { type: 'rename', path },
      ...(name === undefined ? [] : [{ type: 'nameChanged' as const, name }]),
    ]);

  it('starts on the current name', () => {
    expect(renaming('src/notes.md').dialog?.name).toBe('notes.md');
  });

  it('renames within the same folder', () => {
    expect(submission(renaming('src/notes.md', 'notes-renamed.md').dialog!)).toEqual({
      kind: 'rename',
      folder: 'src',
      body: { from: 'src/notes.md', to: 'src/notes-renamed.md' },
    });
  });

  it('the same name just closes it, with nothing sent', () => {
    expect(submission(renaming('notes.md').dialog!)).toEqual({ kind: 'unchanged' });
  });

  it('an empty name asks for one', () => {
    expect(submission(renaming('notes.md', '').dialog!)).toEqual({
      kind: 'refused',
      error: 'Say the new name.',
    });
  });
});

describe('dimming and ghosts', () => {
  it('a gitignored row is dimmed', () => {
    expect(
      rowIgnored(false, { path: 'node_modules', kind: 'dir', sizeBytes: null, ignored: true })
    ).toBe(true);
    expect(rowIgnored(false, file('README.md'))).toBe(false);
  });

  it('everything inside an ignored folder is dimmed, flagged or not', () => {
    expect(rowIgnored(true, { path: 'node_modules/left-pad', kind: 'dir', sizeBytes: null })).toBe(
      true
    );
    expect(rowIgnored(true, file('node_modules/left-pad/index.js'))).toBe(true);
  });

  it('a folder shows the files deleted from it, and only those, by name', () => {
    const marks = new Map<string, FileMark>([
      ['src/z.ts', 'D'],
      ['src/a.ts', 'D'],
      ['src/b.ts', 'M'],
      ['README.md', 'D'],
      ['src/lib/c.ts', 'D'],
    ]);
    expect(ghostsFor(marks, 'src')).toEqual(['src/a.ts', 'src/z.ts']);
    expect(ghostsFor(marks, '')).toEqual(['README.md']);
    expect(ghostsFor(undefined, '')).toEqual([]);
  });

  it('a mark says what happened to the file', () => {
    expect(markTitle('A')).toBe('Added, not committed');
    expect(markTitle('M')).toBe('Changed, not committed');
    expect(markTitle('D')).toBe('Deleted, not committed');
  });

  it('sizes read in B, KB and MB', () => {
    expect(sizeLabel(0)).toBe('0 B');
    expect(sizeLabel(1500)).toBe('1 KB');
    expect(sizeLabel(3_500_000)).toBe('3.3 MB');
  });
});

describe('drops and moves', () => {
  it('a row moves into another folder under its own name', () => {
    expect(moveRequest('README.md', 'src')).toEqual({ from: 'README.md', to: 'src/README.md' });
    expect(moveRequest('src/billing.ts', '')).toEqual({ from: 'src/billing.ts', to: 'billing.ts' });
  });

  it('a row let go where it already is, on itself or inside itself, does not move', () => {
    expect(canMoveInto('src/a.ts', 'src')).toBe(false);
    expect(canMoveInto('src', 'src')).toBe(false);
    expect(canMoveInto('src', 'src/lib')).toBe(false);
    expect(moveRequest('README.md', '')).toBeNull();
    // A sibling whose name starts the same is not inside.
    expect(canMoveInto('src', 'src-old')).toBe(true);
  });

  it('a failed move says which file and why', () => {
    const failed = run([
      { type: 'moveStarted' },
      { type: 'moveFailed', path: 'src/a.ts', error: 'Already exists.' },
    ]);
    expect(failed.moveError).toBe('a.ts: Already exists.');
    expect(run([{ type: 'moveStarted' }], failed).moveError).toBeNull();
  });

  it('files dropped from the desktop land at their names in the folder, or at the root', () => {
    expect(dropUpload('src', ['a.txt', 'b.txt'])).toEqual({
      title: 'Add files to src',
      paths: ['src/a.txt', 'src/b.txt'],
    });
    expect(dropUpload('', ['top.txt'])).toEqual({
      title: 'Add files to the repository root',
      paths: ['top.txt'],
    });
  });
});
