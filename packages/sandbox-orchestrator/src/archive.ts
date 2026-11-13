/**
 * What moves a sandbox's archive: out of the sandbox and into the blob
 * store when it is evicted, and back the other way when the scope gets a
 * new one (orchestrator.ts; the packing is the sandbox worker's own,
 * apps/worker-sandbox/src/archive.ts — a Zstandard-compressed tar).
 *
 * The orchestrator only relays the stream: it is never held whole, here
 * or in the store, and never unpacked outside a sandbox.
 */

import { createHash } from 'node:crypto';
import type { SandboxArchiveStore } from '@renkei/db';

export const ARCHIVE_CONTENT_TYPE = 'application/zstd';

/** Where archives are kept: the blob store, or a stand-in. Each throws with why on failure. */
export interface ArchiveBlobs {
  put(key: string, body: AsyncIterable<Uint8Array>): Promise<{ sizeBytes: number }>;
  /** The object's bytes; null when there is none under the key. */
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Already gone is fine. */
  delete(key: string): Promise<void>;
}

/** A running sandbox's worker, to pull an archive from or push one into. */
export interface ArchiveTransfer {
  /** What the sandbox holds, as a stream; throws when the sandbox refuses. */
  download(sandbox: { url: string; key: string }): Promise<AsyncIterable<Uint8Array>>;
  /** Unpack an archive into the sandbox; resolves once it has. */
  upload(sandbox: { url: string; key: string }, body: ReadableStream<Uint8Array>): Promise<void>;
}

export interface ArchiveOptions {
  store: () => SandboxArchiveStore;
  blobs: ArchiveBlobs;
  transfer?: ArchiveTransfer;
  /** Drop an archive nobody has come back for after this long. */
  retentionMs?: number;
}

export const DEFAULT_ARCHIVE_RETENTION_MS = 90 * 24 * 60 * 60_000;

/**
 * The object an archive of `sandboxId` is kept under. Built from a hash
 * and an id, never from the scope's own text (a subject is whatever the
 * identity provider says it is).
 */
export function archiveBlobKey(routeKey: string, sandboxId: string): string {
  const scope = createHash('sha256').update(routeKey).digest('hex');
  return `sandbox-archives/${scope}/${sandboxId}.tar.zst`;
}

async function refusal(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return `HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`;
}

/** How long a whole archive may take to move; a sandbox's disk is tens of gigabytes at most. */
const TRANSFER_TIMEOUT_MS = 60 * 60_000;

/** The transfer over the sandbox worker's own HTTP surface. */
export const httpArchiveTransfer: ArchiveTransfer = {
  async download(sandbox) {
    const response = await fetch(`${sandbox.url}/v1/archive`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sandbox.key}` },
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error(`the sandbox did not hand over an archive (${await refusal(response)})`);
    }
    return response.body;
  },
  async upload(sandbox, body) {
    const response = await fetch(`${sandbox.url}/v1/restore`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sandbox.key}`,
        'content-type': ARCHIVE_CONTENT_TYPE,
      },
      body,
      // A streamed request body: sent as it is read, never buffered.
      duplex: 'half',
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`the sandbox did not take the archive (${await refusal(response)})`);
    }
    await response.body?.cancel();
  },
};
