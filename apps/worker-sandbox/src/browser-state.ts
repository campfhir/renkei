/**
 * A caller's browser session, kept on the shared data disk between calls
 * so that whichever sandbox replica answers the next call — or this one
 * after a restart — can pick the session up where it was.
 *
 * What a session IS, once its process is gone, is what Playwright can
 * export and import: the context's storage state (cookies, local
 * storage), the URL the page was on, and the ref signatures of the last
 * snapshot the model saw, so a click by an old ref can still find its
 * element by signature after the page is opened again. A live page's DOM
 * is not portable and is not pretended to be: a resumed session reopens
 * the URL, and the verb runs against the page as it loads now.
 *
 * At rest the state is sealed: AES-GCM under a key derived (HKDF) from
 * the worker's env-secrets key and the caller's own identity, so one
 * caller's file opens under no other caller's key, and nothing opens
 * without the deployment's key. Without that key there is no store, and
 * sessions stay as they were — the memory of one replica.
 *
 * Deliberately NOT saved: the secret values a session typed (kept in
 * memory only, to mask them out of what the model reads). A resumed
 * session has none, so a page that echoes a value typed before the
 * resume is not masked. Unlocked browser secrets likewise stay in the
 * replica that unlocked them.
 */

import { createHash, hkdfSync } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { decrypt, encrypt } from '@renkei/crypto';
import { envSecretsKey } from './env-secrets';
import { logger } from './logger';

export interface BrowserStateTarget {
  tenantId: string;
  subject: string;
}

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export interface SavedBrowserState {
  /** The page the session was on; only an http(s) URL is reopened. */
  url: string;
  storageState: StorageState;
  /** ref → (signature, ordinal) from the last snapshot, so an old ref can be recovered by signature. */
  refSignatures: [string, { sig: string; ordinal: number }][];
  savedAt: number;
}

export interface BrowserStateStore {
  load(target: BrowserStateTarget): Promise<SavedBrowserState | null>;
  save(target: BrowserStateTarget, state: SavedBrowserState): Promise<void>;
  remove(target: BrowserStateTarget): Promise<void>;
  /** Drop files older than the TTL; answers how many. */
  sweep(now?: number): Promise<number>;
}

/** How long a saved session stays resumable; cookies inside it may expire sooner. */
export const BROWSER_STATE_TTL_MS = 24 * 60 * 60_000;
const PREFIX = 'bstate1.';
const DIRECTORY = 'browser-state';
const HKDF_SALT = 'renkei-browser-state';

function fileNameFor(target: BrowserStateTarget): string {
  return `${createHash('sha256').update(`${target.tenantId}\n${target.subject}`).digest('hex')}.state`;
}

/** The caller's own sealing key: the deployment's key narrowed to this caller by HKDF. */
export function browserStateKey(rootKey: Buffer, target: BrowserStateTarget): Buffer {
  return Buffer.from(
    hkdfSync('sha256', rootKey, HKDF_SALT, `${target.tenantId}\n${target.subject}`, 32)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSavedState(value: unknown): value is SavedBrowserState {
  if (!isRecord(value)) return false;
  const storage = value.storageState;
  return (
    typeof value.url === 'string' &&
    typeof value.savedAt === 'number' &&
    isRecord(storage) &&
    Array.isArray(storage.cookies) &&
    Array.isArray(storage.origins) &&
    Array.isArray(value.refSignatures)
  );
}

/**
 * The on-disk store under `<dataRoot>/browser-state`, or null when the
 * worker has no sealing key (SANDBOX_ENV_SECRETS_KEY, else
 * TOKEN_ENCRYPTION_KEY) — nothing is ever written unsealed.
 */
export function createBrowserStateStore(
  dataRoot: string,
  rootKey: Buffer | null = envSecretsKey(),
  ttlMs = BROWSER_STATE_TTL_MS
): BrowserStateStore | null {
  if (!rootKey) return null;
  const directory = join(dataRoot, DIRECTORY);
  const pathFor = (target: BrowserStateTarget) => join(directory, fileNameFor(target));
  return {
    async load(target) {
      let sealed: string;
      try {
        sealed = await readFile(pathFor(target), 'utf8');
      } catch {
        return null;
      }
      if (!sealed.startsWith(PREFIX)) return null;
      const opened = decrypt(sealed.slice(PREFIX.length), browserStateKey(rootKey, target));
      if (!opened.ok) {
        logger.warn('a saved browser session did not open under its caller’s key; dropping it', {
          component: 'worker-sandbox/browser-state',
        });
        await rm(pathFor(target), { force: true });
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(opened.val);
      } catch {
        return null;
      }
      if (!isSavedState(parsed)) return null;
      if (parsed.savedAt + ttlMs < Date.now()) {
        await rm(pathFor(target), { force: true });
        return null;
      }
      return parsed;
    },
    async save(target, state) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = pathFor(target);
      const sealed = `${PREFIX}${encrypt(JSON.stringify(state), browserStateKey(rootKey, target))}`;
      // Written whole, then renamed into place: a reader on another
      // replica sees the old state or the new, never half of one.
      const staging = `${path}.${process.pid}.tmp`;
      await writeFile(staging, sealed, { mode: 0o600 });
      await rename(staging, path);
    },
    async remove(target) {
      await rm(pathFor(target), { force: true });
    },
    async sweep(now = Date.now()) {
      let entries: string[];
      try {
        entries = await readdir(directory);
      } catch {
        return 0;
      }
      let removed = 0;
      for (const entry of entries) {
        const path = join(directory, entry);
        try {
          const info = await stat(path);
          const stale = entry.endsWith('.tmp')
            ? info.mtimeMs + 60_000 < now
            : info.mtimeMs + ttlMs < now;
          if (stale) {
            await rm(path, { force: true });
            removed += 1;
          }
        } catch {
          // Gone between readdir and stat — another replica's sweep.
        }
      }
      return removed;
    },
  };
}
