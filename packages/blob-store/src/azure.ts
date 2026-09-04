/**
 * Azure Blob Storage over fetch with Shared Key auth: Put Blob (block
 * blob, single request — every upload is whole and bounded), Get Blob,
 * Delete Blob, and Create Container. Works unchanged against Azurite when
 * the endpoint carries the emulator's account path.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { authorizationHeader } from './azure-sign';
import type { AzureBlobConfig } from './config';
import type { BlobError, BlobObject, BlobObjectStream, BlobStore } from './contract';

const API_VERSION = '2023-11-03';
const REQUEST_TIMEOUT_MS = 90_000;

function encodePath(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function errorOf(status: number, text: string): Result<never, BlobError> {
  if (status === 404) return err('NOT_FOUND' as const, { message: 'No such object.' });
  if (status === 401 || status === 403) {
    return err('AUTH' as const, { message: `Azure Blob refused the credentials (${status}).` });
  }
  return err('PROVIDER_ERROR' as const, {
    message: `Azure Blob ${status}: ${text.slice(0, 300)}`,
  });
}

export function createAzureBlobStore(config: AzureBlobConfig): BlobStore {
  let containerReady = false;

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
        resourcePath,
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
      return errorOf(sent.val.status, await sent.val.text().catch(() => ''));
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
      if (!sent.val.ok) return errorOf(sent.val.status, await sent.val.text().catch(() => ''));
      return ok(undefined);
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
      if (!sent.val.ok) return errorOf(sent.val.status, await sent.val.text().catch(() => ''));
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
      if (!sent.val.ok) return errorOf(sent.val.status, await sent.val.text().catch(() => ''));
      return ok(undefined);
    },
  };
  return store;
}
