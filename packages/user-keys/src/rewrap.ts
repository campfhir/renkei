/**
 * Rotating an org-level root key (DEPLOYMENT.md, "Rotating
 * TOKEN_ENCRYPTION_KEY"): every value the deployment keys seal — connector
 * secrets, model API keys, OIDC client secrets, the VAPID private key,
 * knowledge chunks, a code project's environment secrets and registry
 * credentials — is re-encrypted under the CURRENT key of its ring. A ring
 * is `<current>,<previous>,...` (`TOKEN_ENCRYPTION_KEYS` and the like,
 * packages/crypto secretbox.ts): the previous key opens what is still
 * under it, the current key seals the result as a `v2` envelope naming
 * itself, and once nothing names the previous key it can be dropped.
 *
 * Batched, resumable and idempotent: a row is selected only while its
 * envelope is `v1` or names some other key, so a run killed halfway loses
 * nothing but progress, and a second run finds only what the first did
 * not finish. A row that no key of the ring opens is reported and left as
 * it is — that is a key that was dropped too early, and the fix is to put
 * it back behind the current one, not to lose the row.
 *
 * The transient sealed files the sandbox worker keeps on its own disk
 * (unlocked secret keys, browser sessions — each under a key derived from
 * the root for one owner, for a window of hours) are not here: they expire
 * on their own, and a window that straddles the rotation simply asks its
 * owner to unlock or sign in again. Encrypted log attributes are not here
 * either: `LOG_ENCRYPTION_KEYS` keeps old rows readable, and retention
 * ages them out.
 */

import { getDataStore, type SealedEnvelopeTable } from '@renkei/db';
import {
  contentEncryptionKey,
  decrypt,
  encrypt,
  envelopeKeyId,
  keyId,
  loadKeyring,
  type Keyring,
} from '@renkei/crypto';

export const REWRAP_BATCH = 200;

/** Which deployment key seals a target's values. */
export type RingName = 'token' | 'content' | 'sandbox';

export interface RewrapRings {
  /** TOKEN_ENCRYPTION_KEYS / TOKEN_ENCRYPTION_KEY. */
  token: Keyring;
  /** CONTENT_ENCRYPTION_KEYS / _KEY, else the token ring. */
  content: Keyring;
  /** SANDBOX_ENV_SECRETS_KEYS / _KEY, else the token ring. */
  sandbox: Keyring;
}

/** One column of envelopes: the table, how a row is addressed, and the marker before the envelope. */
export interface RewrapTarget {
  table: SealedEnvelopeTable;
  /** The key columns, in the order rows are walked; text columns only. */
  idColumns: readonly string[];
  column: string;
  /** What precedes the secretbox envelope in the stored value (`renc1:`, `env1.`, ...). */
  prefix: string;
  ring: RingName;
}

/** Every column the deployment keys seal, by the `encrypt(` callers that write it. */
export const REWRAP_TARGETS: readonly RewrapTarget[] = [
  // packages/connector-config: every org-wide connector's secrets (and the
  // Organization → Storage account key, which is a connector row).
  {
    table: 'connector_configs',
    idColumns: ['connector'],
    column: 'encrypted_secrets',
    prefix: '',
    ring: 'token',
  },
  // apps/web/app/api/admin/llm-models: a model's API key.
  {
    table: 'llm_model_configs',
    idColumns: ['id'],
    column: 'encrypted_secrets',
    prefix: '',
    ring: 'token',
  },
  // apps/web/lib/tenant-operations.ts: the OIDC client secret.
  { table: 'oidc_config', idColumns: ['id'], column: 'client_secret', prefix: '', ring: 'token' },
  // packages/knowledge: chunk bodies, `renc1:` + envelope (packages/crypto content.ts).
  {
    table: 'knowledge_chunks',
    idColumns: ['id'],
    column: 'content',
    prefix: 'renc1:',
    ring: 'content',
  },
  // apps/worker-sandbox/src/env-secrets.ts: a code project's environment values.
  {
    table: 'sandbox_env_secrets',
    idColumns: ['id'],
    column: 'sealed',
    prefix: 'env1.',
    ring: 'sandbox',
  },
  // apps/worker-sandbox/src/image-rules-store.ts: a private registry's pull credential.
  {
    table: 'code_service_image_rules',
    idColumns: ['id'],
    column: 'registry_sealed',
    prefix: 'reg1.',
    ring: 'sandbox',
  },
];

export interface RewrapCounts {
  /** Rows now sealed under the current key by this run. */
  rewrapped: number;
  /** Rows no key of the ring opened; listed by id in `unreadable`. */
  skipped: number;
  unreadable: string[];
}

export interface RewrapReport {
  targets: Record<string, RewrapCounts>;
  /** platform_settings.vapid_keys, the one JSON-held envelope. */
  vapid: RewrapCounts;
}

export interface RewrapOptions {
  dryRun?: boolean;
  log?: (line: string) => void;
}

/** The three rings from the environment, each falling back as its readers do. */
export function rewrapRingsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): { ok: true; val: RewrapRings } | { ok: false; message: string } {
  const token = loadKeyring('TOKEN_ENCRYPTION_KEY', env);
  if (!token.ok) {
    return {
      ok: false,
      message: token.err.message ?? 'TOKEN_ENCRYPTION_KEY is not set or malformed',
    };
  }
  const content = contentEncryptionKey(env);
  if (!content.ok) return { ok: false, message: content.err.message ?? 'content key malformed' };
  const sandboxSet = env.SANDBOX_ENV_SECRETS_KEYS || env.SANDBOX_ENV_SECRETS_KEY;
  const sandbox = sandboxSet ? loadKeyring('SANDBOX_ENV_SECRETS_KEY', env) : token;
  if (!sandbox.ok) {
    return { ok: false, message: sandbox.err.message ?? 'SANDBOX_ENV_SECRETS_KEY malformed' };
  }
  return { ok: true, val: { token: token.val, content: content.val, sandbox: sandbox.val } };
}

/** Whether a stored value is already under the ring's current key. */
export function isCurrent(stored: string, prefix: string, ring: Keyring): boolean {
  if (!stored.startsWith(prefix)) return false;
  return envelopeKeyId(stored.slice(prefix.length)) === keyId(ring);
}

/** The value under the current key, or null when no key of the ring opens it. */
export function rewrapValue(stored: string, prefix: string, ring: Keyring): string | null {
  if (!stored.startsWith(prefix)) return null;
  const opened = decrypt(stored.slice(prefix.length), ring);
  if (!opened.ok) return null;
  return prefix + encrypt(opened.val, ring);
}

/** One target, walked in key order in batches of REWRAP_BATCH; only rows not yet under the current key are read. */
export async function rewrapTarget(
  target: RewrapTarget,
  ring: Keyring,
  options: RewrapOptions = {}
): Promise<RewrapCounts> {
  const counts: RewrapCounts = { rewrapped: 0, skipped: 0, unreadable: [] };
  const log = options.log ?? (() => undefined);
  const store = getDataStore().sealedEnvelopes;
  const notCurrent = `${target.prefix}v2.${keyId(ring)}.%`;
  let last: string[] | null = null;
  for (;;) {
    const page = await store.pageNotLike(target, notCurrent, last, REWRAP_BATCH);
    if (page.length === 0) break;
    for (const row of page) {
      const stored = row.value;
      last = row.id;
      const idOf = row.id.join(':');
      const next = rewrapValue(stored, target.prefix, ring);
      if (next === null) {
        counts.skipped += 1;
        counts.unreadable.push(idOf);
        log(`  ${target.table}.${target.column} ${idOf}: no key of the ring opens it; left as is`);
        continue;
      }
      // Only if nobody rewrote it meanwhile (a saved form, another run).
      if (!options.dryRun) await store.replaceIfUnchanged(target, row.id, stored, next);
      counts.rewrapped += 1;
    }
    if (page.length < REWRAP_BATCH) break;
  }
  return counts;
}

function hasEncryptedPrivateKey(value: unknown): value is { encryptedPrivateKey: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'encryptedPrivateKey' in value &&
    typeof value.encryptedPrivateKey === 'string'
  );
}

/** platform_settings.vapid_keys holds its envelope inside a JSON value (packages/notifications vapid.ts). */
export async function rewrapVapid(
  ring: Keyring,
  options: RewrapOptions = {}
): Promise<RewrapCounts> {
  const counts: RewrapCounts = { rewrapped: 0, skipped: 0, unreadable: [] };
  const row = await getDataStore().platformSettings.get('vapid_keys');
  if (!row) return counts;
  const value: unknown = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  if (!hasEncryptedPrivateKey(value)) {
    counts.skipped += 1;
    counts.unreadable.push('vapid_keys (malformed)');
    return counts;
  }
  const stored = value.encryptedPrivateKey;
  if (isCurrent(stored, '', ring)) return counts;
  const next = rewrapValue(stored, '', ring);
  if (next === null) {
    counts.skipped += 1;
    counts.unreadable.push('vapid_keys');
    options.log?.('  platform_settings.vapid_keys: no key of the ring opens it; left as is');
    return counts;
  }
  if (!options.dryRun) {
    await getDataStore().platformSettings.update('vapid_keys', {
      ...value,
      encryptedPrivateKey: next,
    });
  }
  counts.rewrapped += 1;
  return counts;
}

/** Every target, then the VAPID row; the report says what moved and what nothing opened. */
export async function rewrapAll(
  rings: RewrapRings,
  options: RewrapOptions = {}
): Promise<RewrapReport> {
  const log = options.log ?? (() => undefined);
  const report: RewrapReport = {
    targets: {},
    vapid: { rewrapped: 0, skipped: 0, unreadable: [] },
  };
  for (const target of REWRAP_TARGETS) {
    const name = `${target.table}.${target.column}`;
    log(`${name} (${target.ring} ring, current key ${keyId(rings[target.ring])})`);
    const counts = await rewrapTarget(target, rings[target.ring], options);
    report.targets[name] = counts;
    log(
      `  ${options.dryRun ? 'would rewrap' : 'rewrapped'} ${counts.rewrapped}, unreadable ${counts.skipped}`
    );
  }
  log(`platform_settings.vapid_keys (token ring)`);
  report.vapid = await rewrapVapid(rings.token, options);
  log(
    `  ${options.dryRun ? 'would rewrap' : 'rewrapped'} ${report.vapid.rewrapped}, unreadable ${report.vapid.skipped}`
  );
  return report;
}
