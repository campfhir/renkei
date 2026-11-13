/**
 * Streamed writes: an object of unknown length, written without being
 * held whole. The local backend always; Azure when BLOB_LIVE_AZURE_ENDPOINT
 * names an Azurite (or a real account's) endpoint:
 *
 *   docker run -p 10000:10000 mcr.microsoft.com/azure-storage/azurite azurite-blob --blobHost 0.0.0.0 --skipApiVersionCheck
 *   BLOB_LIVE_AZURE_ENDPOINT=http://127.0.0.1:10000/devstoreaccount1 pnpm test stream
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAzureBlobStore } from './azure';
import type { BlobStore } from './contract';
import { createLocalBlobStore } from './local';

// Azurite's published development account; not a secret.
const AZURITE_ACCOUNT = 'devstoreaccount1';
const AZURITE_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

/** `total` bytes of a repeating pattern, handed over in uneven chunks. */
async function* pattern(total: number, chunk: number): AsyncGenerator<Uint8Array> {
  let sent = 0;
  while (sent < total) {
    const size = Math.min(chunk, total - sent);
    const part = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) part[index] = (sent + index) % 251;
    sent += size;
    yield part;
  }
}

async function* failing(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1, 2, 3]);
  throw new Error('the source went away');
}

function streamedWrites(
  name: string,
  make: () => Promise<{ store: BlobStore; done: () => Promise<void> }>
) {
  describe(`a streamed write to the ${name} store`, () => {
    let store: BlobStore;
    let done: () => Promise<void>;
    beforeEach(async () => {
      ({ store, done } = await make());
    });
    afterEach(async () => {
      await done();
    });

    it('writes an object larger than one block and reads back the same bytes', async () => {
      // Twenty megabytes: three blocks on Azure, the last one short.
      const total = 20 * 1_048_576 + 17;
      const key = 'sandbox-archives/test/big.tar.zst';
      const put = await store.putObjectStream(key, pattern(total, 1_000_003), 'application/zstd');
      if (!put.ok) throw new Error(`expected ok: ${put.err}`);
      expect(put.val.sizeBytes).toBe(total);

      const read = await store.getObject(key);
      if (!read.ok) throw new Error('expected ok');
      expect(read.val.bytes.byteLength).toBe(total);
      expect(read.val.contentType).toBe('application/zstd');
      let same = true;
      for (let index = 0; index < total; index += 104_729) {
        if (read.val.bytes[index] !== index % 251) same = false;
      }
      expect(same).toBe(true);
      expect(read.val.bytes[total - 1]).toBe((total - 1) % 251);
      await store.deleteObject(key);
    }, 120_000);

    it('writes an empty object from an empty stream', async () => {
      const key = 'sandbox-archives/test/empty';
      const put = await store.putObjectStream(key, pattern(0, 1), 'application/zstd');
      if (!put.ok) throw new Error(`expected ok: ${put.err}`);
      expect(put.val.sizeBytes).toBe(0);
      const read = await store.getObject(key);
      if (!read.ok) throw new Error('expected ok');
      expect(read.val.bytes.byteLength).toBe(0);
      await store.deleteObject(key);
    });

    it('leaves what was there when the stream fails half way', async () => {
      const key = 'sandbox-archives/test/kept';
      await store.putObject(key, new TextEncoder().encode('the earlier archive'), 'text/plain');
      const put = await store.putObjectStream(key, failing(), 'application/zstd');
      expect(put.ok).toBe(false);
      const read = await store.getObject(key);
      if (!read.ok) throw new Error('expected ok');
      expect(new TextDecoder().decode(read.val.bytes)).toBe('the earlier archive');
      await store.deleteObject(key);
    });
  });
}

streamedWrites('local', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'renkei-blobs-'));
  return {
    store: createLocalBlobStore({ provider: 'local', dir }),
    done: async () => {
      // Nothing half-written is left beside the objects.
      const left = await readdir(dir, { recursive: true }).catch(() => []);
      expect(left.filter((name) => name.endsWith('.partial'))).toEqual([]);
      await rm(dir, { recursive: true, force: true });
    },
  };
});

const endpoint = process.env.BLOB_LIVE_AZURE_ENDPOINT;
if (endpoint) {
  streamedWrites('Azure', async () => ({
    store: createAzureBlobStore({
      provider: 'azure',
      account: process.env.BLOB_LIVE_AZURE_ACCOUNT ?? AZURITE_ACCOUNT,
      key: process.env.BLOB_LIVE_AZURE_KEY ?? AZURITE_KEY,
      container: 'renkei-stream-test',
      endpoint,
    }),
    done: async () => undefined,
  }));
}
