/**
 * Live SMB round-trip against the container from
 * docker-compose.fileshares-test.yaml. Skips itself without the env vars.
 * This suite is also the standing check on @tryjsky/v9u-smb2 itself — the library
 * was chosen for being pure JS, and this is where that bet is verified
 * against a real server.
 */

import { openSmbBackend } from './smb';
import type { ShareSummary } from './types';

const host = process.env.FILESHARE_TEST_SMB_HOST;
const shareName = process.env.FILESHARE_TEST_SMB_SHARE;
const user = process.env.FILESHARE_TEST_SMB_USER;
const password = process.env.FILESHARE_TEST_SMB_PASSWORD;

const describeLive = host && shareName && user && password ? describe : describe.skip;

function share(): ShareSummary {
  return {
    id: 'itest-smb',
    name: 'itest',
    protocol: 'smb',
    host: host ?? '',
    port: process.env.FILESHARE_TEST_SMB_PORT ? Number(process.env.FILESHARE_TEST_SMB_PORT) : null,
    shareName: shareName ?? '',
    rootPath: '/',
    caseInsensitive: true,
    maxAccess: 'read_write',
    enabled: true,
    hasCredentials: true,
  };
}

describeLive('smb backend (live)', () => {
  it('writes, lists, stats, reads and refuses traversal', async () => {
    const opened = openSmbBackend(share(), {
      protocol: 'smb',
      username: user ?? '',
      password: password ?? '',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const backend = opened.val;

    try {
      const dir = `/itest-${Date.now()}`;
      expect((await backend.mkdir(dir)).ok).toBe(true);

      const body = new TextEncoder().encode('hello from renkei');
      expect((await backend.write(`${dir}/hello.txt`, body)).ok).toBe(true);

      const listed = await backend.list(dir);
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.val.map((entry) => entry.name)).toContain('hello.txt');
      }

      const stats = await backend.stat(`${dir}/hello.txt`);
      expect(stats.ok).toBe(true);
      if (stats.ok) expect(stats.val.size).toBe(body.byteLength);

      const read = await backend.read(`${dir}/hello.txt`, 1024);
      expect(read.ok).toBe(true);
      if (read.ok) expect(new TextDecoder().decode(read.val)).toBe('hello from renkei');

      const missing = await backend.stat(`${dir}/nope.txt`);
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.err.type).toBe('not_found');
    } finally {
      await backend.close();
    }
  }, 30_000);

  it('renames, moves, and deletes with the guarded semantics', async () => {
    const opened = openSmbBackend(share(), {
      protocol: 'smb',
      username: user ?? '',
      password: password ?? '',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const backend = opened.val;

    try {
      const dir = `/mvtest-${Date.now()}`;
      const sub = `${dir}/sub`;
      expect((await backend.mkdir(dir)).ok).toBe(true);
      expect((await backend.mkdir(sub)).ok).toBe(true);
      const body = new TextEncoder().encode('payload');
      expect((await backend.write(`${dir}/a.txt`, body)).ok).toBe(true);
      expect((await backend.write(`${dir}/blocker.txt`, body)).ok).toBe(true);

      // Rename in place, then move into a subfolder.
      expect((await backend.rename(`${dir}/a.txt`, `${dir}/b.txt`)).ok).toBe(true);
      expect((await backend.rename(`${dir}/b.txt`, `${sub}/b.txt`)).ok).toBe(true);
      const moved = await backend.read(`${sub}/b.txt`, 1024);
      expect(moved.ok).toBe(true);

      // Clobbering is refused.
      const clobber = await backend.rename(`${sub}/b.txt`, `${dir}/blocker.txt`);
      expect(clobber.ok).toBe(false);
      if (!clobber.ok) expect(clobber.err.type).toBe('exists');

      // Rename a folder.
      expect((await backend.rename(sub, `${dir}/sub2`)).ok).toBe(true);
      const inRenamed = await backend.stat(`${dir}/sub2/b.txt`);
      expect(inRenamed.ok).toBe(true);

      // A non-empty folder does not delete.
      const notEmpty = await backend.remove(`${dir}/sub2`, 'dir');
      expect(notEmpty.ok).toBe(false);
      if (!notEmpty.ok) expect(notEmpty.err.type).toBe('not_empty');

      // Files, then the emptied folders, delete cleanly.
      expect((await backend.remove(`${dir}/sub2/b.txt`, 'file')).ok).toBe(true);
      expect((await backend.remove(`${dir}/blocker.txt`, 'file')).ok).toBe(true);
      expect((await backend.remove(`${dir}/sub2`, 'dir')).ok).toBe(true);
      expect((await backend.remove(dir, 'dir')).ok).toBe(true);

      // Convergent contract: removing what is already gone succeeds.
      expect((await backend.remove(`${dir}/sub2/b.txt`, 'file')).ok).toBe(true);
    } finally {
      await backend.close();
    }
  }, 30_000);
});
