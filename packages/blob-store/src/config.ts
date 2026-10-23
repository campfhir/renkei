/**
 * Which backend, and its credentials — from the environment, the same
 * way the worker URLs and keys are wired. Unconfigured means closed:
 * every store operation answers `BLOB_UNCONFIGURED` and the upload UI
 * says so, rather than anything falling back to disk.
 *
 *   BLOB_STORE_PROVIDER   'azure', or 'local' — files on this machine's
 *                         disk, for development and the Playwright suite
 *                         (local.ts); 's3' is the next slot and is refused
 *                         until it exists
 *   BLOB_STORE_LOCAL_DIR  where the local backend keeps its files
 *   AZURE_BLOB_ACCOUNT    storage account name (Azurite: devstoreaccount1)
 *   AZURE_BLOB_KEY        the account's shared key, base64
 *   AZURE_BLOB_CONTAINER  container name, default renkei-chat
 *   AZURE_BLOB_ENDPOINT   optional; default https://{account}.blob.core.windows.net.
 *                         For Azurite: http://azurite:10000/devstoreaccount1
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export interface AzureBlobConfig {
  provider: 'azure';
  account: string;
  key: string;
  container: string;
  endpoint: string;
}

export interface LocalBlobConfig {
  provider: 'local';
  dir: string;
}

export type BlobStoreConfig = AzureBlobConfig | LocalBlobConfig;

const DEFAULT_CONTAINER = 'renkei-chat';
const CONTAINER_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

export function blobStoreConfig(
  env: Record<string, string | undefined> = process.env
): Result<BlobStoreConfig, 'BLOB_UNCONFIGURED'> {
  const provider = (env.BLOB_STORE_PROVIDER ?? '').trim().toLowerCase();
  if (!provider) {
    return err('BLOB_UNCONFIGURED' as const, { message: 'BLOB_STORE_PROVIDER is not set.' });
  }
  if (provider === 'local') {
    const dir = (env.BLOB_STORE_LOCAL_DIR ?? '').trim();
    if (!dir) {
      return err('BLOB_UNCONFIGURED' as const, {
        message: 'BLOB_STORE_LOCAL_DIR is required for the local backend.',
      });
    }
    return ok({ provider: 'local', dir });
  }
  if (provider !== 'azure') {
    return err('BLOB_UNCONFIGURED' as const, {
      message: `No blob store backend for provider "${provider}".`,
    });
  }
  const account = (env.AZURE_BLOB_ACCOUNT ?? '').trim();
  const key = (env.AZURE_BLOB_KEY ?? '').trim();
  const container = (env.AZURE_BLOB_CONTAINER ?? '').trim() || DEFAULT_CONTAINER;
  if (!account || !key) {
    return err('BLOB_UNCONFIGURED' as const, {
      message: 'AZURE_BLOB_ACCOUNT and AZURE_BLOB_KEY are required.',
    });
  }
  if (!CONTAINER_NAME.test(container)) {
    return err('BLOB_UNCONFIGURED' as const, {
      message: 'AZURE_BLOB_CONTAINER must be 3–63 lowercase letters, digits or hyphens.',
    });
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(key, 'base64');
  } catch {
    decoded = Buffer.alloc(0);
  }
  if (decoded.length === 0) {
    return err('BLOB_UNCONFIGURED' as const, { message: 'AZURE_BLOB_KEY is not valid base64.' });
  }
  let endpoint =
    (env.AZURE_BLOB_ENDPOINT ?? '').trim() || `https://${account}.blob.core.windows.net`;
  while (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1);
  try {
    new URL(endpoint);
  } catch {
    return err('BLOB_UNCONFIGURED' as const, { message: 'AZURE_BLOB_ENDPOINT is not a URL.' });
  }
  return ok({ provider: 'azure', account, key, container, endpoint });
}
