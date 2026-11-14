/**
 * Where evicted sandboxes' archives are kept: the organization's file
 * storage — the store an operator sets up on Organization → Storage, or
 * the deployment's own (`BLOB_STORE_PROVIDER`) where the organization has
 * none (@renkei/blob-store's tenant.ts) — under `sandbox-archives/`,
 * beside the chat's files and apart from them by that prefix.
 *
 * The store is looked up for each archive, so storage configured after
 * this process started is used from the next eviction. With none
 * configured an archive cannot be written, and a sandbox whose archive
 * cannot be written is not removed: it stays suspended, with its work,
 * and the eviction is tried again later.
 *
 * How long an archive is kept is the organization's setting
 * (`sandboxArchiveRetentionDays`, 90 days unless changed).
 */

import { resolveTenantBlobStore, type BlobStore } from '@renkei/blob-store';
import { ARCHIVE_CONTENT_TYPE, type ArchiveBlobs } from '@renkei/sandbox-orchestrator';
import { getOrgSettings } from '@renkei/settings';

/** The organization's store now; null when it has none. */
export async function organizationBlobStore(): Promise<BlobStore | null> {
  const store = await resolveTenantBlobStore();
  return store.ok ? store.val : null;
}

/** The store as the orchestrator uses it: a failure is thrown, with the store's own words. */
export function archiveBlobsOf(resolve: () => Promise<BlobStore | null>): ArchiveBlobs {
  const refused = (what: string, failure: { type: string; message?: unknown }): Error =>
    new Error(
      `the blob store could not ${what} the archive: ${
        typeof failure.message === 'string' && failure.message ? failure.message : failure.type
      }`
    );
  const store = async (): Promise<BlobStore> => {
    const found = await resolve();
    if (!found) {
      throw new Error(
        'no file storage is configured for the organization (Organization → Storage), so there is nowhere to keep the archive'
      );
    }
    return found;
  };
  return {
    async put(key, body) {
      const put = await (await store()).putObjectStream(key, body, ARCHIVE_CONTENT_TYPE);
      if (!put.ok) throw refused('keep', put.err);
      return put.val;
    },
    async get(key) {
      const got = await (await store()).getObjectStream(key);
      if (got.ok) return got.val.body;
      if (got.err.type === 'NOT_FOUND') return null;
      throw refused('read', got.err);
    },
    async delete(key) {
      const deleted = await (await store()).deleteObject(key);
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
