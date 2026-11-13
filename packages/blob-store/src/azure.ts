/**
 * Azure Blob Storage over fetch with Shared Key auth: Put Blob (block
 * blob, single request — a chat upload is whole and bounded), Put Block
 * and Put Block List for a streamed write of unknown length (a sandbox's
 * archive), Get Blob, Delete Blob, and Create Container. Works unchanged
 * against Azurite when the endpoint carries the emulator's account path.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { authorizationHeader } from './azure-sign';
import { describeRefusal } from './azure-errors';
import type { AzureBlobConfig } from './config';
import type { BlobError, BlobObject, BlobObjectStream, BlobStore } from './contract';

const API_VERSION = '2023-11-03';
const REQUEST_TIMEOUT_MS = 90_000;
/** How much of a streamed write is held and sent at once. A block blob takes 50,000 of them. */
const BLOCK_BYTES = 8 * 1_048_576;

/** Block ids must be base64 and all of one length within a blob. */
function blockId(index: number): string {
  return Buffer.from(`block-${String(index).padStart(8, '0')}`).toString('base64');
}

function encodePath(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** A non-2xx answer, told apart by who sent it (azure-errors.ts). */
async function refused(response: Response): Promise<Result<never, BlobError>> {
  const body = await response.text().catch(() => '');
  const refusal = describeRefusal(response.status, response.headers, body);
  return err(refusal.kind, { message: refusal.message });
}

export function createAzureBlobStore(config: AzureBlobConfig): BlobStore {
  let containerReady = false;
  // An emulator (Azurite) is addressed path-style, with the account as
  // the endpoint's first path segment, and counts that segment as part of
  // the resource it signs: `/{account}/{account}/{container}/{blob}`.
  const pathStyle = new URL(config.endpoint).pathname.replace(/\/+$/, '') === `/${config.account}`;

  const send = async (
    verb: 'PUT' | 'GET' | 'DELETE',
    resourcePath: string,
    query: Record<string, string>,
    extraHeaders: Record<string, string>,
    body?: Uint8Array
  ): Promise<Result<Response, BlobError>> => {
    const headers: Record<string, string> = {
      'x-ms-date': new Date().toUTCString(),
      'x-ms-version': API_VERSION,
      ...extraHeaders,
    };
    const contentLength = body ? body.byteLength : 0;
    headers.authorization = authorizationHeader(
      {
        verb,
        headers,
        contentLength,
        account: config.account,
        resourcePath: pathStyle ? `/${config.account}${resourcePath}` : resourcePath,
        query,
      },
      config.key
    );
    const search = new URLSearchParams(query).toString();
    const url = `${config.endpoint}${encodePath(resourcePath)}${search ? `?${search}` : ''}`;
    // Copy into a plain ArrayBuffer: BodyInit rejects a view over a
    // possibly-shared buffer, and the copy is bounded by the upload cap.
    let payload: ArrayBuffer | undefined;
    if (body) {
      payload = new ArrayBuffer(body.byteLength);
      new Uint8Array(payload).set(body);
    }
    try {
      const response = await fetch(url, {
        method: verb,
        headers: { ...headers, ...(body ? { 'content-length': String(contentLength) } : {}) },
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return ok(response);
    } catch (error) {
      return err('NETWORK' as const, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const containerPath = `/${config.container}`;
  const blobPath = (key: string) => `/${config.container}/${key}`;

  const store: BlobStore = {
    provider: 'azure',

    async ensureContainer() {
      if (containerReady) return ok(undefined);
      const sent = await send('PUT', containerPath, { restype: 'container' }, {});
      if (!sent.ok) return sent;
      // 201 created, 409 already exists — both mean "it is there".
      if (sent.val.ok || sent.val.status === 409) {
        containerReady = true;
        return ok(undefined);
      }
      return refused(sent.val);
    },

    async putObject(key, bytes, contentType) {
      const ready = await store.ensureContainer();
      if (!ready.ok) return ready;
      const sent = await send(
        'PUT',
        blobPath(key),
        {},
        {
          'x-ms-blob-type': 'BlockBlob',
          'content-type': contentType || 'application/octet-stream',
        },
        bytes
      );
      if (!sent.ok) return sent;
      if (!sent.val.ok) return refused(sent.val);
      return ok(undefined);
    },

    async putObjectStream(key, body, contentType) {
      const ready = await store.ensureContainer();
      if (!ready.ok) return ready;
      // Blocks are staged uncommitted and only the final list makes them
      // the blob, so a stream that fails half way leaves the key as it was
      // (the service discards uncommitted blocks after a week).
      const ids: string[] = [];
      let sizeBytes = 0;
      const putBlock = async (block: Uint8Array): Promise<Result<void, BlobError>> => {
        const id = blockId(ids.length);
        const sent = await send('PUT', blobPath(key), { comp: 'block', blockid: id }, {}, block);
        if (!sent.ok) return sent;
        if (!sent.val.ok) return refused(sent.val);
        ids.push(id);
        sizeBytes += block.byteLength;
        return ok(undefined);
      };
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      const flush = async (): Promise<Result<void, BlobError>> => {
        const block = new Uint8Array(pendingBytes);
        let offset = 0;
        for (const part of pending) {
          block.set(part, offset);
          offset += part.byteLength;
        }
        pending = [];
        pendingBytes = 0;
        return putBlock(block);
      };
      try {
        for await (const chunk of body) {
          let rest = chunk;
          while (rest.byteLength > 0) {
            const take = Math.min(rest.byteLength, BLOCK_BYTES - pendingBytes);
            pending.push(rest.subarray(0, take));
            pendingBytes += take;
            rest = rest.subarray(take);
            if (pendingBytes === BLOCK_BYTES) {
              const flushed = await flush();
              if (!flushed.ok) return flushed;
            }
          }
        }
      } catch (error) {
        return err('NETWORK' as const, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      // An empty stream commits an empty list: an empty blob.
      if (pendingBytes > 0) {
        const flushed = await flush();
        if (!flushed.ok) return flushed;
      }
      const list = new TextEncoder().encode(
        `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids
          .map((id) => `<Latest>${id}</Latest>`)
          .join('')}</BlockList>`
      );
      const committed = await send(
        'PUT',
        blobPath(key),
        { comp: 'blocklist' },
        { 'x-ms-blob-content-type': contentType || 'application/octet-stream' },
        list
      );
      if (!committed.ok) return committed;
      if (!committed.val.ok) return refused(committed.val);
      return ok({ sizeBytes });
    },

    async getObject(key) {
      const streamed = await store.getObjectStream(key);
      if (!streamed.ok) return streamed;
      try {
        const bytes = new Uint8Array(await new Response(streamed.val.body).arrayBuffer());
        const object: BlobObject = { bytes, contentType: streamed.val.contentType };
        return ok(object);
      } catch (error) {
        return err('NETWORK' as const, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async getObjectStream(key) {
      const sent = await send('GET', blobPath(key), {}, {});
      if (!sent.ok) return sent;
      if (!sent.val.ok) return refused(sent.val);
      if (!sent.val.body) {
        return err('PROVIDER_ERROR' as const, { message: 'Azure Blob returned no body.' });
      }
      const length = sent.val.headers.get('content-length');
      const stream: BlobObjectStream = {
        body: sent.val.body,
        contentType: sent.val.headers.get('content-type'),
        contentLength: length && /^\d+$/.test(length) ? Number(length) : null,
      };
      return ok(stream);
    },

    async deleteObject(key) {
      const sent = await send('DELETE', blobPath(key), {}, {});
      if (!sent.ok) return sent;
      if (!sent.val.ok) return refused(sent.val);
      return ok(undefined);
    },
  };
  return store;
}
