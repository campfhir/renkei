/**
 * The object-store contract the chat's attachments live behind.
 *
 * Deliberately four verbs and a container check: every byte that enters
 * the store is a whole file already in memory (uploads are capped by the
 * org's attachment limit before they are read), every read either wants
 * the whole file (text extraction, staging into the sandbox) or a stream
 * to forward to a browser, and deletion is what retention does. Signed
 * URLs are absent on purpose — downloads always go through the app under
 * a session check, so a link can never outlive the access that minted it.
 *
 * Backends are chosen by configuration (`BLOB_STORE_PROVIDER`), and each
 * speaks its provider's HTTP API directly over fetch — the same stance as
 * the LLM adapters: no SDK's agenda becomes the platform's.
 */

import type { Result } from '@campfhir/safe-functions/types';

export type BlobError = 'BLOB_UNCONFIGURED' | 'NOT_FOUND' | 'AUTH' | 'NETWORK' | 'PROVIDER_ERROR';

export interface BlobObject {
  bytes: Uint8Array;
  contentType: string | null;
}

export interface BlobObjectStream {
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  contentLength: number | null;
}

export interface BlobStore {
  /** Which backend this is, for logs and the health page. */
  readonly provider: string;
  putObject(key: string, bytes: Uint8Array, contentType: string): Promise<Result<void, BlobError>>;
  getObject(key: string): Promise<Result<BlobObject, BlobError>>;
  getObjectStream(key: string): Promise<Result<BlobObjectStream, BlobError>>;
  /** Idempotent: a missing object is `NOT_FOUND`, never a thrown error. */
  deleteObject(key: string): Promise<Result<void, BlobError>>;
  /**
   * Make sure the container/bucket exists. Idempotent; the store calls it
   * lazily before the first write so a fresh deployment needs no init job.
   */
  ensureContainer(): Promise<Result<void, BlobError>>;
}
