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
});
