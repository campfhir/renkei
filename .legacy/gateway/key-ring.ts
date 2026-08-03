/**
 * Which key protects which tenant's grants.
 *
 * A small cache in front of `tenant_keys`, because the answer is needed on every
 * grant read and write and changes about once a year. The TTL is short — a minute
 * — so a tenant turning its own key on takes effect promptly without anybody
 * restarting anything, and so does turning it off.
 *
 * Shared across the per-request `PostgresStore` views rather than built per
 * request: a cache with a per-request lifetime is not a cache.
 */

import type pg from 'pg';
import { decrypt } from '../crypto/secretbox.js';
import type { KeySet } from '../crypto/envelope.js';

/** Long enough to be a cache, short enough that a key change is not a deploy. */
const TTL_MS = 60 * 1000;

/**
 * A tenant whose key exists but cannot be used.
 *
 * Distinct from a decryption failure, because the operational answer is
 * different: this is "the key service is unreachable" or "this deployment cannot
 * do KMS", not "the ciphertext is wrong". A specific error is what lets the
 * request path say so rather than returning a 500 that looks like a database
 * problem — the hazard the design doc asks to be designed for rather than
 * discovered.
 */
export class TenantKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantKeyUnavailableError';
  }
}

export interface KeyRingOptions {
  pool: pg.Pool;
  /** The deployment key, which wraps a tenant's literal key and protects v1 rows. */
  deploymentKey: Buffer;
  now: () => number;
}

interface Cached {
  keys: KeySet;
  at: number;
}

export class KeyRing {
  readonly #pool: pg.Pool;
  readonly #deploymentKey: Buffer;
  readonly #now: () => number;
  readonly #cache = new Map<string, Cached>();

  constructor(options: KeyRingOptions) {
    this.#pool = options.pool;
    this.#deploymentKey = options.deploymentKey;
    this.#now = options.now;
  }

  async keysFor(tenantId: string): Promise<KeySet> {
    const cached = this.#cache.get(tenantId);
    if (cached !== undefined && this.#now() - cached.at < TTL_MS) {
      return cached.keys;
    }

    const keys: KeySet = { deployment: this.#deploymentKey, tenant: await this.#load(tenantId) };
    this.#cache.set(tenantId, { keys, at: this.#now() });
    return keys;
  }

  /** Forgets a tenant's key, so the next read picks up a change immediately. */
  forget(tenantId: string): void {
    this.#cache.delete(tenantId);
  }

  async #load(tenantId: string): Promise<Buffer | null> {
    // Tenant-scoped like every other read of a tenant table, so a bug here is a
    // missing row rather than another tenant's key.
    const client = await this.#pool.connect();
    let row: { source?: unknown; wrapped_key?: unknown; kms_provider?: unknown } | undefined;

    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['renkei.tenant_id', tenantId]);
      const result = await client.query(
        'SELECT source, wrapped_key, kms_provider FROM tenant_keys WHERE tenant_id = $1',
        [tenantId],
      );
      await client.query('COMMIT');
      row = result.rows[0] as typeof row;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    // Absent means the deployment key. Every optional table in this schema is
    // absent-means-default, so the simple deployment does not pay for the
    // complicated one.
    if (row === undefined || row.source === 'deployment') return null;

    if (row.source === 'kms') {
      throw new TenantKeyUnavailableError(
        'this tenant is configured for a KMS-held key, which this deployment cannot use yet. ' +
          'Every session for the tenant will fail until its key is changed — see ' +
          'docs/multi-tenancy.md § BYOK.',
      );
    }

    if (typeof row.wrapped_key !== 'string') {
      throw new TenantKeyUnavailableError(
        'this tenant is configured for its own key and no key is stored',
      );
    }

    // Wrapped under the deployment key, so the platform operator is not
    // cryptographically excluded — which is why this is honestly a per-tenant key
    // rather than BYOK in the sense a customer means it. Only a KMS key they hold
    // is that, and it is not built.
    const key = Buffer.from(decrypt(row.wrapped_key, this.#deploymentKey), 'base64');

    if (key.byteLength !== 32) {
      throw new TenantKeyUnavailableError('this tenant’s stored key is not 32 bytes');
    }

    return key;
  }
}
