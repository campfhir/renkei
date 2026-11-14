/**
 * The archive on the wire: an orchestrated sandbox hands over what it
 * holds as one stream, and a new one takes it back; a shared worker does
 * neither.
 */

import type { Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSandboxServer } from './server';

const KEY = 'sandbox-key';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

const close = (server: Server) => new Promise((resolve) => server.close(resolve));

const post = (base: string, op: string, body?: BodyInit, key = KEY) =>
  fetch(`${base}/v1/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body,
  });

describe('an orchestrated sandbox', () => {
  let dir: string;
  let roots: string[];
  let server: Server;
  let base: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'renkei-archive-http-'));
    roots = [path.join(dir, 'data'), path.join(dir, 'workspaces')];
    for (const root of roots) await mkdir(root, { recursive: true });
    server = createSandboxServer({ apiKeys: [KEY], orchestrated: true, archiveRoots: () => roots });
    base = await listen(server);
  });
  afterEach(async () => {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  });

  it('hands over what it holds, and a fresh one takes it back as it was', async () => {
    await mkdir(path.join(roots[1]!, 'caller', 'checkout'), { recursive: true });
    await writeFile(path.join(roots[1]!, 'caller', 'checkout', 'notes.md'), 'uncommitted work');
    await writeFile(path.join(roots[0]!, 'staged'), 'a staged file');

    const archived = await post(base, 'archive');
    expect(archived.status).toBe(200);
    expect(archived.headers.get('content-type')).toBe('application/zstd');
    const archive = new Uint8Array(await archived.arrayBuffer());

    // The machine goes; a new one starts empty.
    for (const root of roots) {
      await rm(root, { recursive: true });
      await mkdir(root);
    }
    const restored = await post(base, 'restore', archive);
    expect(restored.status).toBe(200);
    expect(await readFile(path.join(roots[1]!, 'caller', 'checkout', 'notes.md'), 'utf8')).toBe(
      'uncommitted work'
    );
    expect(await readFile(path.join(roots[0]!, 'staged'), 'utf8')).toBe('a staged file');
  });

  it('refuses what is not an archive and says the restore failed', async () => {
    const restored = await post(base, 'restore', 'not an archive');
    expect(restored.status).toBe(500);
    expect(await restored.json()).toMatchObject({ error: { type: 'restore_failed' } });
  });

  it('cuts the stream short, rather than answer a whole archive of less, when a directory is missing', async () => {
    await rm(roots[0]!, { recursive: true });
    // Cut before or after the headers left: either way no whole body arrives.
    await expect(
      post(base, 'archive').then((archived) => archived.arrayBuffer())
    ).rejects.toBeDefined();
  });

  it('takes its key from x-sandbox-key when the bearer is something else’s token', async () => {
    const guarded = (key: string) =>
      fetch(`${base}/v1/restore`, {
        method: 'POST',
        headers: { authorization: 'Bearer an-ingress-token', 'x-sandbox-key': key },
        body: 'not an archive',
      });
    // Let in (and then told the body is no archive), or not let in at all.
    expect((await guarded(KEY)).status).toBe(500);
    expect((await guarded('wrong')).status).toBe(401);
  });

  it('hands nothing to a caller without its key', async () => {
    expect((await post(base, 'archive', undefined, 'wrong')).status).toBe(401);
    expect((await post(base, 'restore', 'x', 'wrong')).status).toBe(401);
  });
});

describe('a shared sandbox worker', () => {
  it('neither packs nor unpacks: what it holds is everyone’s', async () => {
    const server = createSandboxServer({ apiKeys: [KEY] });
    const base = await listen(server);
    expect((await post(base, 'archive')).status).toBe(404);
    expect((await post(base, 'restore', 'x')).status).toBe(404);
    await close(server);
  });
});
