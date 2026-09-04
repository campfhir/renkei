/**
 * Which backend, and its credentials — from the environment, the same
 * way the worker URLs and keys are wired. Unconfigured means closed:
 * every store operation answers `BLOB_UNCONFIGURED` and the upload UI
 * says so, rather than anything falling back to disk.
 *
 *   BLOB_STORE_PROVIDER   'azure' (the only backend today; 's3' is the
 *                         next slot and is refused until it exists)
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

export type BlobStoreConfig = AzureBlobConfig;

const DEFAULT_CONTAINER = 'renkei-chat';
const CONTAINER_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

export function blobStoreConfig(
  env: Record<string, string | undefined> = process.env
): Result<BlobStoreConfig, 'BLOB_UNCONFIGURED'> {
  const provider = (env.BLOB_STORE_PROVIDER ?? '').trim().toLowerCase();
  if (!provider) {
    return err('BLOB_UNCONFIGURED' as const, { message: 'BLOB_STORE_PROVIDER is not set.' });
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
  const endpoint = (
    (env.AZURE_BLOB_ENDPOINT ?? '').trim() || `https://${account}.blob.core.windows.net`
  ).replace(/\/+$/, '');
  try {
    new URL(endpoint);
  } catch {
    return err('BLOB_UNCONFIGURED' as const, { message: 'AZURE_BLOB_ENDPOINT is not a URL.' });
  }
  return ok({ provider: 'azure', account, key, container, endpoint });
}
