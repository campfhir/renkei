import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { blobStoreConfig } from './config';
import { createLocalBlobStore } from './local';

describe('local blob store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'renkei-blobs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is configured by BLOB_STORE_PROVIDER=local and a directory', () => {
    const config = blobStoreConfig({ BLOB_STORE_PROVIDER: 'local', BLOB_STORE_LOCAL_DIR: dir });
    if (!config.ok) throw new Error('expected ok');
    expect(config.val).toEqual({ provider: 'local', dir });
    expect(blobStoreConfig({ BLOB_STORE_PROVIDER: 'local' }).ok).toBe(false);
  });

  it('round-trips bytes and the content type, whole and streamed', async () => {
    const store = createLocalBlobStore({ provider: 'local', dir });
    const bytes = new TextEncoder().encode('# Guide\n\nRound half to even.');
    const put = await store.putObject(
      'chat/e2e/11111111-1111-4111-8111-111111111111',
      bytes,
      'text/markdown'
    );
    expect(put.ok).toBe(true);

    const whole = await store.getObject('chat/e2e/11111111-1111-4111-8111-111111111111');
    if (!whole.ok) throw new Error('expected ok');
    expect(new TextDecoder().decode(whole.val.bytes)).toBe('# Guide\n\nRound half to even.');
    expect(whole.val.contentType).toBe('text/markdown');

    const streamed = await store.getObjectStream('chat/e2e/11111111-1111-4111-8111-111111111111');
    if (!streamed.ok) throw new Error('expected ok');
    expect(streamed.val.contentLength).toBe(bytes.byteLength);
    expect(await new Response(streamed.val.body).text()).toBe('# Guide\n\nRound half to even.');
  });

  it('answers NOT_FOUND for a missing object and refuses a key that leaves the root', async () => {
    const store = createLocalBlobStore({ provider: 'local', dir });
    expect((await store.getObject('chat/e2e/missing')).ok).toBe(false);
    const missing = await store.deleteObject('chat/e2e/missing');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.err.type).toBe('NOT_FOUND');
    const escape = await store.putObject('../outside', new Uint8Array([1]), 'text/plain');
    expect(escape.ok).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it('deletes the object and its sidecar', async () => {
    const store = createLocalBlobStore({ provider: 'local', dir });
    await store.putObject('chat/e2e/a', new Uint8Array([1, 2, 3]), 'application/octet-stream');
    expect((await store.deleteObject('chat/e2e/a')).ok).toBe(true);
    expect(await readdir(path.join(dir, 'chat', 'e2e'))).toEqual([]);
    expect((await store.getObject('chat/e2e/a')).ok).toBe(false);
  });
});
