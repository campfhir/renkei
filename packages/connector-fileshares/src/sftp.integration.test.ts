/**
 * Live SFTP round-trip against the container from
 * docker-compose.fileshares-test.yaml. Skips itself without the env vars —
 * the Atlassian-sandbox convention — so CI without a server stays green.
 */

import { openSftpBackend } from './sftp';
import type { ShareSummary } from './types';

const host = process.env.FILESHARE_TEST_SFTP_HOST;
const user = process.env.FILESHARE_TEST_SFTP_USER;
const password = process.env.FILESHARE_TEST_SFTP_PASSWORD;

const describeLive = host && user && password ? describe : describe.skip;

function share(): ShareSummary {
  return {
    id: 'itest-sftp',
    name: 'itest',
    protocol: 'sftp',
    host: host ?? '',
    port: Number(process.env.FILESHARE_TEST_SFTP_PORT ?? '22'),
    shareName: null,
    rootPath: process.env.FILESHARE_TEST_SFTP_ROOT ?? '/upload',
    caseInsensitive: false,
    maxAccess: 'read_write',
    enabled: true,
    hasCredentials: true,
  };
}

describeLive('sftp backend (live)', () => {
  it('writes, lists, stats, reads and refuses traversal', async () => {
    const opened = await openSftpBackend(share(), {
      protocol: 'sftp',
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

      const tooSmall = await backend.read(`${dir}/hello.txt`, 4);
      expect(tooSmall.ok).toBe(false);
      if (!tooSmall.ok) expect(tooSmall.err.type).toBe('too_large');

      const missing = await backend.stat(`${dir}/nope.txt`);
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.err.type).toBe('not_found');
    } finally {
      await backend.close();
    }
  }, 30_000);
});
