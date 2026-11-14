import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { readArchive, writeArchive } from './archive';

/** An archive of `roots`, whole, in memory. */
async function pack(roots: string[]): Promise<Buffer> {
  const sink = new PassThrough();
  // Read to the stream's END, not merely until the writer is done: the
  // last chunk is still on its way out of the stream when the write side finishes.
  const [archive] = await Promise.all([buffer(sink), writeArchive(roots, sink)]);
  return archive;
}

describe('a sandbox’s archive', () => {
  let dir: string;
  let data: string;
  let workspaces: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'renkei-archive-'));
    data = path.join(dir, 'data');
    workspaces = path.join(dir, 'workspaces');
    await mkdir(path.join(data, 'tenant', 'files'), { recursive: true });
    await mkdir(path.join(workspaces, 'caller', 'checkout', 'src'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('brings back every file, mode and link where it was', async () => {
    await writeFile(path.join(data, 'tenant', 'files', 'staged.bin'), Buffer.from([0, 1, 2, 255]));
    await writeFile(path.join(workspaces, 'caller', 'checkout', 'src', 'index.ts'), 'export {};\n');
    await writeFile(path.join(workspaces, 'caller', 'checkout', 'run.sh'), '#!/bin/sh\n');
    await chmod(path.join(workspaces, 'caller', 'checkout', 'run.sh'), 0o755);
    await chmod(path.join(workspaces, 'caller'), 0o700);
    await symlink('src/index.ts', path.join(workspaces, 'caller', 'checkout', 'main'));

    const archive = await pack([data, workspaces]);
    await rm(data, { recursive: true });
    await rm(workspaces, { recursive: true });
    await readArchive([data, workspaces], Readable.from([archive]));

    expect(await readFile(path.join(data, 'tenant', 'files', 'staged.bin'))).toEqual(
      Buffer.from([0, 1, 2, 255])
    );
    expect(
      await readFile(path.join(workspaces, 'caller', 'checkout', 'src', 'index.ts'), 'utf8')
    ).toBe('export {};\n');
    expect((await lstat(path.join(workspaces, 'caller', 'checkout', 'run.sh'))).mode & 0o777).toBe(
      0o755
    );
    expect((await lstat(path.join(workspaces, 'caller'))).mode & 0o777).toBe(0o700);
    expect(await readlink(path.join(workspaces, 'caller', 'checkout', 'main'))).toBe(
      'src/index.ts'
    );
  });

  it('is compressed: a tree of repetitive text comes out a fraction of its size', async () => {
    const line = 'const answer = 42; // the same line, over and over\n';
    await writeFile(path.join(workspaces, 'caller', 'checkout', 'big.ts'), line.repeat(40_000));
    const archive = await pack([data, workspaces]);
    expect(archive.length).toBeLessThan((line.length * 40_000) / 20);
    // Zstandard's frame magic.
    expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  });

  it('takes nothing from outside the sandbox’s own directories', async () => {
    const elsewhere = path.join(dir, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'secret'), 'not the sandbox’s');
    await writeFile(path.join(data, 'kept'), 'the sandbox’s');
    // An archive that holds another directory as well.
    const archive = await pack([data, elsewhere]);
    await rm(data, { recursive: true });
    await rm(elsewhere, { recursive: true });
    await readArchive([data, workspaces], Readable.from([archive])).catch(() => undefined);
    expect(await readFile(path.join(data, 'kept'), 'utf8')).toBe('the sandbox’s');
    await expect(lstat(elsewhere)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('says so when what it is handed is not an archive', async () => {
    await expect(
      readArchive([data, workspaces], Readable.from([Buffer.from('not an archive at all')]))
    ).rejects.toThrow(/could not be read/);
  });

  it('says so when a directory to pack is not there', async () => {
    await expect(pack([path.join(dir, 'missing')])).rejects.toThrow(/could not pack/);
  });
});
