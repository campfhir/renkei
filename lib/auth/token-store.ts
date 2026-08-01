/**
 * Persistence for a single Atlassian grant, used by the stdio entrypoint.
 *
 * Only the two token fields are encrypted. The rest — which site, which
 * account, when the access token expires — stays readable so an operator can
 * inspect the file without a key and without exposing anything usable. The
 * file is written 0600 via a temp-file rename so a crash mid-write cannot
 * leave a half-written grant behind.
 *
 * The multi-user gateway replaces this with the Postgres-backed store in
 * migrations/1737400002_create-oauth-tokens.cjs; the `TokenStore` interface is
 * the seam.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { decrypt, encrypt } from '../crypto/secretbox.js';

/** A grant with tokens in plaintext. Never serialize this directly. */
export interface Grant {
  /**
   * The Atlassian OAuth client the grant was minted by.
   *
   * Part of the identity of a grant, not incidental metadata: a refresh token
   * belongs to a (user, OAuth client, site) triple, so two grants differing
   * only in this field are separate credentials with separate rotation chains.
   * The gateway relies on it to tell one tenant's grants from another's.
   */
  atlassianClientId: string;
  cloudId: string;
  siteUrl: string;
  accountId: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  /** Absolute access-token expiry, ISO 8601. */
  expiresAt: string;
  scopes: string[];
  updatedAt: string;
}

export interface TokenStore {
  read(): Promise<Grant | null>;
  write(grant: Grant): Promise<void>;
  clear(): Promise<void>;
}

const persistedGrantSchema = z.object({
  // v2 added atlassianClientId, which a v1 file does not record.
  //
  // It could be inferred from current config, and that inference would nearly
  // always be right: a grant minted by a different app would already be dead,
  // since refreshing it needs that app's client ID and secret. It is refused
  // anyway. This field is part of a credential's identity, and a guessed value
  // is indistinguishable afterwards from a recorded one — the cost of being
  // wrong is a credential attributed to the wrong client for the rest of its
  // life, against a saving of one `pnpm auth`.
  version: z.literal(2),
  atlassianClientId: z.string().min(1),
  cloudId: z.string().min(1),
  siteUrl: z.string(),
  accountId: z.string().min(1),
  displayName: z.string(),
  encryptedAccessToken: z.string().min(1),
  encryptedRefreshToken: z.string().min(1),
  expiresAt: z.string().min(1),
  scopes: z.array(z.string()),
  updatedAt: z.string().min(1),
});

export class TokenStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TokenStoreError';
  }
}

export class FileTokenStore implements TokenStore {
  readonly path: string;
  readonly #key: Buffer;

  constructor(path: string, key: Buffer) {
    this.path = path;
    this.#key = key;
  }

  async read(): Promise<Grant | null> {
    let contents: string;

    try {
      contents = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw new TokenStoreError(`could not read token store at ${this.path}`, { cause: error });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(contents);
    } catch (error) {
      throw new TokenStoreError(
        `token store at ${this.path} is not valid JSON — re-run \`pnpm auth\``,
        { cause: error },
      );
    }

    const result = persistedGrantSchema.safeParse(parsedJson);
    if (!result.success) {
      // A v1 file is the expected case here. Saying which problem it is beats a
      // generic shape error, because the fix differs: one needs re-authorizing,
      // the other means the file is damaged.
      const version = (parsedJson as { version?: unknown } | null)?.version;
      const detail =
        version === 1
          ? 'was written before grants recorded their Atlassian client and cannot be upgraded'
          : 'has an unrecognized shape';
      throw new TokenStoreError(`token store at ${this.path} ${detail} — re-run \`pnpm auth\``);
    }

    const persisted = result.data;

    return {
      atlassianClientId: persisted.atlassianClientId,
      cloudId: persisted.cloudId,
      siteUrl: persisted.siteUrl,
      accountId: persisted.accountId,
      displayName: persisted.displayName,
      accessToken: decrypt(persisted.encryptedAccessToken, this.#key),
      refreshToken: decrypt(persisted.encryptedRefreshToken, this.#key),
      expiresAt: persisted.expiresAt,
      scopes: persisted.scopes,
      updatedAt: persisted.updatedAt,
    };
  }

  async write(grant: Grant): Promise<void> {
    const persisted: z.infer<typeof persistedGrantSchema> = {
      version: 2,
      atlassianClientId: grant.atlassianClientId,
      cloudId: grant.cloudId,
      siteUrl: grant.siteUrl,
      accountId: grant.accountId,
      displayName: grant.displayName,
      encryptedAccessToken: encrypt(grant.accessToken, this.#key),
      encryptedRefreshToken: encrypt(grant.refreshToken, this.#key),
      expiresAt: grant.expiresAt,
      scopes: grant.scopes,
      updatedAt: grant.updatedAt,
    };

    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });

    // Write-then-rename: rename is atomic within a filesystem, so a reader
    // never observes a partially written grant. Mode is set on the temp file
    // before it is moved into place, so the final file is never briefly 0644.
    const tempPath = `${this.path}.${process.pid}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.path);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw new TokenStoreError(`could not write token store at ${this.path}`, { cause: error });
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if (!isNotFound(error)) {
        throw new TokenStoreError(`could not remove token store at ${this.path}`, {
          cause: error,
        });
      }
    }
  }
}

/** Test double. Keeps the grant in memory with no encryption. */
export class InMemoryTokenStore implements TokenStore {
  #grant: Grant | null;

  constructor(grant: Grant | null = null) {
    this.#grant = grant;
  }

  read(): Promise<Grant | null> {
    return Promise.resolve(this.#grant);
  }

  write(grant: Grant): Promise<void> {
    this.#grant = grant;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#grant = null;
    return Promise.resolve();
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
