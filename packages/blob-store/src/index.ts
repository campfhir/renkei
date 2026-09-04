/**
 * @renkei/blob-store — the org's object store behind one small interface.
 *
 * `getBlobStore()` is a process singleton keyed on the configuration it
 * was built from, so a changed environment is picked up on restart and a
 * missing one answers closed. Anchored on globalThis like the database
 * client: Next compiles routes, instrumentation and the proxy as separate
 * module graphs, and module scope would give each its own copy.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { blobStoreConfig } from './config';
import { createAzureBlobStore } from './azure';
import type { BlobStore } from './contract';

export type { BlobError, BlobObject, BlobObjectStream, BlobStore } from './contract';
export { blobStoreConfig, type AzureBlobConfig, type BlobStoreConfig } from './config';
export { chatAttachmentKey } from './keys';
export { createAzureBlobStore } from './azure';
export { stringToSign, sharedKeySignature, authorizationHeader } from './azure-sign';

interface BlobStoreState {
  store: BlobStore | null;
  fingerprint: string;
}

declare global {
  var __renkeiBlobStore: BlobStoreState | undefined;
}

export function getBlobStore(): Result<BlobStore, 'BLOB_UNCONFIGURED'> {
  const config = blobStoreConfig();
  if (!config.ok) return config;
  const fingerprint = JSON.stringify(config.val);
  const state = globalThis.__renkeiBlobStore;
  if (state?.store && state.fingerprint === fingerprint) return ok(state.store);
  const store = createAzureBlobStore(config.val);
  globalThis.__renkeiBlobStore = { store, fingerprint };
  return ok(store);
}

/** Whether uploads can be accepted at all — the UI's "attachments off" switch. */
export function blobStoreConfigured(): boolean {
  return blobStoreConfig().ok;
}

/** Test hook. */
export function resetBlobStore(): void {
  globalThis.__renkeiBlobStore = undefined;
}

export function blobStoreUnavailable(): Result<never, 'BLOB_UNCONFIGURED'> {
  return err('BLOB_UNCONFIGURED' as const, { message: 'No blob store is configured.' });
}
