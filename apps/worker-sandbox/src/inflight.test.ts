/**
 * The note an instance keeps of what it is doing, and what the next run
 * makes of a note that was never cleared.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Inflight,
  describeInflight,
  detailOf,
  inflightFile,
  takePreviousInflight,
} from './inflight';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'inflight-'));
  const made = inflightFile(dir, 'sandbox-4');
  if (!made) throw new Error('no note file');
  file = made;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const onDisk = (): { op: string }[] => JSON.parse(readFileSync(file, 'utf8'));
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('while it runs', () => {
  it('a request is on disk before it is handled, and off it once answered', async () => {
    const inflight = new Inflight(file);
    const done = inflight.begin('workspaces/find', 'code-project:p1', { id: 'ws-1', glob: '**/*' });
    // Synchronously: a request that ends the process at once is already written.
    expect(onDisk()).toMatchObject([
      { op: 'workspaces/find', subject: 'code-project:p1', detail: 'id: ws-1, glob: **/*' },
    ]);
    done();
    await settle();
    expect(onDisk()).toEqual([]);
  });

  it('several under way are all there; each goes as it ends', async () => {
    const inflight = new Inflight(file);
    const first = inflight.begin('workspaces/exec', 'ann', { id: 'ws-1' });
    const second = inflight.begin('workspaces/kernel/execute', 'ann', { path: 'n.ipynb' });
    expect(onDisk().map((entry) => entry.op)).toEqual([
      'workspaces/exec',
      'workspaces/kernel/execute',
    ]);
    first();
    first(); // Ending twice is ending once.
    await settle();
    expect(onDisk().map((entry) => entry.op)).toEqual(['workspaces/kernel/execute']);
    second();
    await settle();
    expect(onDisk()).toEqual([]);
  });

  it('notes where a request points, never what it carries', () => {
    expect(
      detailOf({
        id: 'ws-1',
        path: 'notebooks/n.ipynb',
        command: 'curl -H "Authorization: Bearer sekret" https://x',
        code: 'TOKEN = "sekret"',
        url: 'https://x/?token=sekret',
      })
    ).toBe('id: ws-1, path: notebooks/n.ipynb');
    expect(detailOf({})).toBeNull();
  });

  it('messages to a language server, one per keystroke, are not noted', () => {
    const inflight = new Inflight(file);
    inflight.begin('workspaces/lsp/send', 'ann', {});
    expect(inflight.current()).toEqual([]);
  });

  it('a clean stop leaves nothing to explain', () => {
    const inflight = new Inflight(file);
    inflight.begin('workspaces/exec', 'ann', {});
    inflight.clear();
    expect(onDisk()).toEqual([]);
    expect(takePreviousInflight(file)).toEqual([]);
  });

  it('a disk that cannot be written does not stop a request', () => {
    const inflight = new Inflight(join(dir, 'no-such-directory', 'note.json'));
    const done = inflight.begin('workspaces/exec', 'ann', {});
    expect(inflight.current()).toHaveLength(1);
    done();
  });

  it('with nowhere to write, it is simply not kept', () => {
    const inflight = new Inflight(null);
    inflight.begin('workspaces/exec', 'ann', {})();
    expect(inflight.current()).toEqual([]);
  });
});

describe('the next run', () => {
  it('finds what the last one was doing when it ended without a word, once', () => {
    // The last run: two requests under way, then killed — no end, no clear.
    const last = new Inflight(file);
    last.begin('workspaces/kernel/execute', 'code-project:p1', {
      id: 'ws-1',
      path: 'notebooks/xcure_pipeline.ipynb',
    });
    last.begin('workspaces/git-diff', 'code-project:p1', { id: 'ws-1' });

    const found = takePreviousInflight(file);
    expect(found.map((entry) => entry.op)).toEqual([
      'workspaces/kernel/execute',
      'workspaces/git-diff',
    ]);
    expect(describeInflight(found[0]!)).toMatch(
      /^workspaces\/kernel\/execute for code-project:p1 \(id: ws-1, path: notebooks\/xcure_pipeline\.ipynb\) since \d{4}-/
    );
    // Said once: the note is cleared for this run.
    expect(takePreviousInflight(file)).toEqual([]);
  });

  it('a first start, and a note that cannot be read, have nothing to say', () => {
    expect(takePreviousInflight(join(dir, 'instances', 'never-ran.inflight.json'))).toEqual([]);
    writeFileSync(file, '{not json');
    expect(takePreviousInflight(file)).toEqual([]);
    writeFileSync(file, '{"op": "x"}');
    expect(takePreviousInflight(file)).toEqual([]);
    expect(takePreviousInflight(null)).toEqual([]);
  });

  it('an instance’s name cannot point the note outside its directory', () => {
    expect(inflightFile(dir, '../../etc/passwd')).toBe(
      join(dir, 'instances', '.._.._etc_passwd.inflight.json')
    );
  });
});
