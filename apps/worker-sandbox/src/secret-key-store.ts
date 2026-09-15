/**
 * An unlocked browser secret's key, kept on the shared data disk for the
 * length of its unlock window so that every sandbox replica — and this
 * one after a restart — can type the secret, not only the replica that
 * saw the passphrase.
 *
 * This is a deliberate widening of the vault's original promise that an
 * unlocked key exists in one process's memory and nowhere else. What is
 * written is the passphrase-derived key (never the passphrase, never a
 * field value), sealed with AES-GCM under a key HKDF-derived from the
 * worker's env-secrets key and the secret's owner (tenant, subject) and
 * id — so for the window, the deployment's key plus the disk opens the
 * secret, and nothing else does; a wrong key, a moved file or a past
 * window reads as locked. Locking deletes the file, so a lock on any
 * replica locks all. Without an env-secrets key there is no store, and
 * the vault keeps keys in memory as before.
 */

import { createHash, hkdfSync } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decrypt, encrypt } from '@renkei/crypto';
import { envSecretsKey } from './env-secrets';
import { logger } from './logger';

export interface SecretOwner {
  tenantId: string;
  subject: string;
}

export interface HeldKey {
  key: Buffer;
  until: number;
}

export interface SecretKeyStore {
  load(owner: SecretOwner, secretId: string, now: number): Promise<HeldKey | null>;
  save(owner: SecretOwner, secretId: string, held: HeldKey): Promise<void>;
  /** Forget the key; true when one was on disk. */
  remove(secretId: string): Promise<boolean>;
  /** Drop files past their window (each carries it sealed; the file's age is the bound used here). */
  sweep(now?: number): Promise<number>;
}

/** The longest unlock window the UI allows (24h), plus slack: a file older than this is stale whatever it says. */
const FILE_MAX_AGE_MS = 25 * 60 * 60_000;
const PREFIX = 'skey1.';
const DIRECTORY = 'secret-keys';
const HKDF_SALT = 'renkei-secret-key';

function isHeldRecord(value: unknown): value is { key: string; until: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    typeof value.key === 'string' &&
    'until' in value &&
    typeof value.until === 'number'
  );
}

function fileNameFor(secretId: string): string {
  return `${createHash('sha256').update(secretId).digest('hex')}.key`;
}

/** The sealing key for one secret's held key: the deployment's key narrowed to this owner and secret. */
export function secretKeySealingKey(rootKey: Buffer, owner: SecretOwner, secretId: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', rootKey, HKDF_SALT, `${owner.tenantId}\n${owner.subject}\n${secretId}`, 32)
  );
}

export function createSecretKeyStore(
  dataRoot: string,
  rootKey: Buffer | null = envSecretsKey()
): SecretKeyStore | null {
  if (!rootKey) return null;
  const directory = join(dataRoot, DIRECTORY);
  const pathFor = (secretId: string) => join(directory, fileNameFor(secretId));
  return {
    async load(owner, secretId, now) {
      let sealed: string;
      try {
        sealed = await readFile(pathFor(secretId), 'utf8');
      } catch {
        return null;
      }
      if (!sealed.startsWith(PREFIX)) return null;
      const opened = decrypt(
        sealed.slice(PREFIX.length),
        secretKeySealingKey(rootKey, owner, secretId)
      );
      if (!opened.ok) {
        logger.warn('a held secret key did not open under its owner’s key; dropping it', {
          component: 'worker-sandbox/secret-keys',
        });
        await rm(pathFor(secretId), { force: true });
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(opened.val);
      } catch {
        return null;
      }
      if (!isHeldRecord(parsed)) return null;
      if (parsed.until <= now) {
        await rm(pathFor(secretId), { force: true });
        return null;
      }
      return { key: Buffer.from(parsed.key, 'base64'), until: parsed.until };
    },
    async save(owner, secretId, held) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = pathFor(secretId);
      const sealed = `${PREFIX}${encrypt(
        JSON.stringify({ key: held.key.toString('base64'), until: held.until }),
        secretKeySealingKey(rootKey, owner, secretId)
      )}`;
      const staging = `${path}.${process.pid}.tmp`;
      await writeFile(staging, sealed, { mode: 0o600 });
      await rename(staging, path);
    },
    async remove(secretId) {
      const path = pathFor(secretId);
      try {
        await stat(path);
      } catch {
        return false;
      }
      await rm(path, { force: true });
      return true;
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
            : info.mtimeMs + FILE_MAX_AGE_MS < now;
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
