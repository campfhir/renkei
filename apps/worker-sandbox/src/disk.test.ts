/**
 * The scratch disk's modes are explicit, not the umask's: whatever umask
 * this process started with, a staged file is 0600 and every directory
 * on the way to it 0700 — so a script dropped to another uid on the same
 * filesystem (scripts.ts) can read nothing staged for anyone.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as disk from './disk';

let root: string;
let previousUmask: number;

beforeAll(async () => {
  // The permissive umask a developer's shell has — the worst case.
  previousUmask = process.umask(0o022);
  root = await mkdtemp(join(tmpdir(), 'renkei-disk-'));
  disk.setDataRootForTests(join(root, 'data'));
  await disk.ensureDataRoot();
});

afterAll(async () => {
  process.umask(previousUmask);
  await rm(root, { recursive: true, force: true });
});

function modeOf(path: string): Promise<number> {
  return stat(path).then((info) => info.mode & 0o777);
}

describe('scratch disk modes', () => {
  it('makes the data root 0700 whatever the umask', async () => {
    expect(await modeOf(disk.getDataRoot())).toBe(0o700);
  });

  it('stages a file 0600 under 0700 directories', async () => {
    const key = disk.newStorageKey('auth0|alice');
    const written = await disk.writeStream(key, Readable.from([Buffer.from('bytes')]), 1024);
    expect(written).toEqual({ ok: true, sizeBytes: 5 });
    const path = join(disk.getDataRoot(), key);
    expect(await modeOf(path)).toBe(0o600);
    expect(await modeOf(join(path, '..'))).toBe(0o700);
    expect(await modeOf(join(path, '..', '..'))).toBe(0o700);
  });

  it('copies a staged file out 0600 for the run directory to narrow further', async () => {
    const key = disk.newStorageKey('auth0|alice');
    await disk.writeStream(key, Readable.from([Buffer.from('bytes')]), 1024);
    const destination = join(root, 'copy.bin');
    expect(await disk.copyFileTo(key, destination)).toBe(true);
    expect(await modeOf(destination)).toBe(0o600);
  });
});
