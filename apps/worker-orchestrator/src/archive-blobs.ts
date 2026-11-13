/**
 * Where evicted sandboxes' archives are kept: the deployment's blob
 * store (`BLOB_STORE_PROVIDER` and its variables — @renkei/blob-store),
 * in a container of their own on Azure so their lifetime and access can
 * be set apart from chat attachments'.
 *
 *   SANDBOX_ARCHIVE_CONTAINER       the Azure container, default
 *                                   `renkei-sandbox-archives`.
 *
 * How long an archive is kept is not a variable here: it is the
 * organization's setting (`sandboxArchiveRetentionDays`, 90 days unless
 * changed).
 *
 * With no blob store configured there are no archives: an evicted
 * sandbox's work goes with its machine, and boot says so.
 */

import {
  blobStoreConfig,
  createAzureBlobStore,
  createLocalBlobStore,
  type BlobStore,
} from '@renkei/blob-store';
import { ARCHIVE_CONTENT_TYPE, type ArchiveBlobs } from '@renkei/sandbox-orchestrator';
import { getOrgSettings } from '@renkei/settings';

type Env = Record<string, string | undefined>;

const DEFAULT_CONTAINER = 'renkei-sandbox-archives';

/** The blob store archives go to; null when the deployment has none. */
export function archiveBlobStore(env: Env): BlobStore | null {
  const config = blobStoreConfig({
    ...env,
    AZURE_BLOB_CONTAINER: env.SANDBOX_ARCHIVE_CONTAINER?.trim() || DEFAULT_CONTAINER,
  });
  if (!config.ok) return null;
  return config.val.provider === 'local'
    ? createLocalBlobStore(config.val)
    : createAzureBlobStore(config.val);
}

/** The store as the orchestrator uses it: a failure is thrown, with the store's own words. */
export function archiveBlobsOf(store: BlobStore): ArchiveBlobs {
  const refused = (what: string, failure: { type: string; message?: unknown }): Error =>
    new Error(
      `the blob store could not ${what} the archive: ${
        typeof failure.message === 'string' && failure.message ? failure.message : failure.type
      }`
    );
  return {
    async put(key, body) {
      const put = await store.putObjectStream(key, body, ARCHIVE_CONTENT_TYPE);
      if (!put.ok) throw refused('keep', put.err);
      return put.val;
    },
    async get(key) {
      const got = await store.getObjectStream(key);
      if (got.ok) return got.val.body;
      if (got.err.type === 'NOT_FOUND') return null;
      throw refused('read', got.err);
    },
    async delete(key) {
      const deleted = await store.deleteObject(key);
      if (!deleted.ok && deleted.err.type !== 'NOT_FOUND') throw refused('delete', deleted.err);
    },
  };
}

/**
 * How long an archive nobody comes back for is kept: the organization's
 * own setting (admin → Settings → Sandbox), read on every sweep. Null
 * when the settings cannot be read: nothing is dropped on a guess.
 */
export async function archiveRetentionMs(): Promise<number | null> {
  const settings = await getOrgSettings();
  if (!settings.ok) return null;
  return settings.val.sandboxArchiveRetentionDays * 24 * 60 * 60_000;
}
