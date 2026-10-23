/**
 * A blob store on the local disk: one file per object under a directory,
 * its content type in a sidecar beside it. For development and the
 * Playwright suite, where there is no Azure and no emulator — uploads,
 * downloads, text extraction and retention then run end to end against
 * real bytes. Not for a deployment: nothing here is replicated, and the
 * directory is whatever the environment said.
 *
 * Keys are the store's own (`chat/<domain>/<uuid>`, keys.ts), so they
 * become paths as they are; anything that could step outside the root is
 * refused as NOT_FOUND rather than resolved.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { LocalBlobConfig } from './config';
import type { BlobError, BlobObject, BlobObjectStream, BlobStore } from './contract';

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}

function failure(error: unknown): Result<never, BlobError> {
  const code = codeOf(error);
  if (code === 'ENOENT') return err('NOT_FOUND' as const);
  if (code === 'EACCES' || code === 'EPERM') {
    return err('AUTH' as const, { message: 'The blob directory is not writable.' });
  }
  return err('PROVIDER_ERROR' as const, {
    message: error instanceof Error ? error.message : String(error),
  });
}

export function createLocalBlobStore(config: LocalBlobConfig): BlobStore {
  const root = path.resolve(config.dir);
  const pathOf = (key: string): string | null => {
    if (!SAFE_KEY.test(key)) return null;
    const target = path.resolve(root, key);
    return target.startsWith(root + path.sep) ? target : null;
  };
  const metaOf = (file: string): string => `${file}.meta.json`;

  const store: BlobStore = {
    provider: 'local',

    async ensureContainer() {
      try {
        await mkdir(root, { recursive: true });
        return ok(undefined);
      } catch (error) {
        return failure(error);
      }
    },

    async putObject(key, bytes, contentType) {
      const file = pathOf(key);
      if (!file) return err('NOT_FOUND' as const);
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes);
        await writeFile(metaOf(file), JSON.stringify({ contentType }));
        return ok(undefined);
      } catch (error) {
        return failure(error);
      }
    },

    async getObject(key) {
      const file = pathOf(key);
      if (!file) return err('NOT_FOUND' as const);
      try {
        const [bytes, contentType] = await Promise.all([
          readFile(file),
          readContentType(metaOf(file)),
        ]);
        const object: BlobObject = { bytes: new Uint8Array(bytes), contentType };
        return ok(object);
      } catch (error) {
        return failure(error);
      }
    },

    async getObjectStream(key) {
      const file = pathOf(key);
      if (!file) return err('NOT_FOUND' as const);
      try {
        const [size, contentType] = await Promise.all([stat(file), readContentType(metaOf(file))]);
        const stream: BlobObjectStream = {
          body: webStreamOf(file),
          contentType,
          contentLength: size.size,
        };
        return ok(stream);
      } catch (error) {
        return failure(error);
      }
    },

    async deleteObject(key) {
      const file = pathOf(key);
      if (!file) return err('NOT_FOUND' as const);
      try {
        await stat(file);
      } catch (error) {
        return failure(error);
      }
      try {
        await rm(file, { force: true });
        await rm(metaOf(file), { force: true });
        return ok(undefined);
      } catch (error) {
        return failure(error);
      }
    },
  };
  return store;
}

/**
 * The file as a web stream. Node's `Readable.toWeb` returns its own
 * `ReadableStream<any>`, which the web app's DOM typing of the contract
 * does not accept; a stream built on the contract's own type does.
 */
function webStreamOf(file: string): ReadableStream<Uint8Array> {
  const source = createReadStream(file);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on('data', (chunk: Buffer | string) => {
        controller.enqueue(
          typeof chunk === 'string'
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        );
      });
      source.on('end', () => controller.close());
      source.on('error', (error) => controller.error(error));
    },
    cancel() {
      source.destroy();
    },
  });
}

async function readContentType(metaFile: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metaFile, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('contentType' in parsed)) return null;
    const contentType: unknown = parsed.contentType;
    return typeof contentType === 'string' ? contentType : null;
  } catch {
    return null;
  }
}
