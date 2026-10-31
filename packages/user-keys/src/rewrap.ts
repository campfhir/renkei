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
 * `--aad` mode (audit R-04, "secretbox envelopes carry no associated data"):
 * the same walk, but every row of a target that has a purpose
 * (`RewrapTarget.aad`) is re-sealed as a `v3` envelope BOUND to that purpose
 * (and its row where the writer binds one), whatever it was before: legacy
 * `v1`/`v2`, or `v3` under an older key. It is the operator step that makes
 * rows sealed before the AAD release relocation-proof; run it once after
 * every service runs the AAD release (older readers cannot open `v3`), then
 * optionally set RENKEI_REQUIRE_AAD=1. Targets without a purpose
 * (sandbox secrets, registry credentials, VAPID) are left alone in this
 * mode. A plain rotation keeps whatever binding a row has: a `v3` row is
 * opened and re-sealed under its own AAD, a legacy row stays legacy.
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
  AAD_PURPOSE,
  aadFor,
  contentEncryptionKey,
  decrypt,
  encrypt,
  envelopeKeyId,
  isBoundEnvelope,
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
  /**
   * The associated data this column's writer binds, from the row's id
   * columns; absent for columns that still seal without it.
   */
  aad?: (id: readonly string[]) => string;
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
    aad: (id) => aadFor(AAD_PURPOSE.connectorConfig, id[0]),
  },
  // apps/web/app/api/admin/llm-models: a model's API key.
  {
    table: 'llm_model_configs',
    idColumns: ['id'],
    column: 'encrypted_secrets',
    prefix: '',
    ring: 'token',
    // Purpose only: the create route may copy a sibling row's blob.
    aad: () => aadFor(AAD_PURPOSE.llmModelKey),
  },
  // apps/web/lib/tenant-operations.ts: the OIDC client secret.
  {
    table: 'oidc_config',
    idColumns: ['id'],
    column: 'client_secret',
    prefix: '',
    ring: 'token',
    aad: () => aadFor(AAD_PURPOSE.oidcClientSecret),
  },
  // packages/knowledge: chunk bodies, `renc1:` + envelope (packages/crypto content.ts).
  {
    table: 'knowledge_chunks',
    idColumns: ['id'],
    column: 'content',
    prefix: 'renc1:',
    ring: 'content',
    // Purpose only: the chunk id is assigned after sealing.
    aad: () => aadFor(AAD_PURPOSE.knowledgeChunk),
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
  /** Re-seal every row of a target that has a purpose as a `v3` envelope bound to it (see the header). */
  aad?: boolean;
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

/**
 * Whether a stored value is already as the run wants it: under the ring's
 * current key and, in `--aad` mode, bound (`v3`).
 */
export function isCurrent(
  stored: string,
  prefix: string,
  ring: Keyring,
  options: { aad?: boolean } = {}
): boolean {
  if (!stored.startsWith(prefix)) return false;
  const envelope = stored.slice(prefix.length);
  if (envelopeKeyId(envelope) !== keyId(ring)) return false;
  return options.aad ? isBoundEnvelope(envelope) : true;
}

/**
 * The value under the current key, or null when no key of the ring opens it.
 * `aad` is the associated data of the row's purpose, when it has one:
 * a `v3` value opens only under it and is sealed again under it; a legacy
 * value is sealed legacy unless `bind` asks for it to be bound.
 */
export function rewrapValue(
  stored: string,
  prefix: string,
  ring: Keyring,
  aad?: string,
  bind = false
): string | null {
  if (!stored.startsWith(prefix)) return null;
  const envelope = stored.slice(prefix.length);
  if (isBoundEnvelope(envelope)) {
    if (aad === undefined) return null;
    const opened = decrypt(envelope, ring, aad);
    return opened.ok ? prefix + encrypt(opened.val, ring, aad) : null;
  }
  const opened = decrypt(envelope, ring);
  if (!opened.ok) return null;
  return prefix + encrypt(opened.val, ring, bind ? aad : undefined);
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
  if (options.aad && !target.aad) return counts;
  // In --aad mode a row is done only once it is a v3 under the current key;
  // otherwise v2 under it is done, and a v3 under it (whose bound form the
  // pattern cannot exclude) is skipped below.
  const notCurrent = `${target.prefix}${options.aad ? 'v3' : 'v2'}.${keyId(ring)}.%`;
  let last: string[] | null = null;
  for (;;) {
    const page = await store.pageNotLike(target, notCurrent, last, REWRAP_BATCH);
    if (page.length === 0) break;
    for (const row of page) {
      const stored = row.value;
      last = row.id;
      const idOf = row.id.join(':');
      if (!options.aad && isCurrent(stored, target.prefix, ring)) continue;
      const aad = target.aad?.(row.id);
      const next = rewrapValue(stored, target.prefix, ring, aad, options.aad === true);
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
    if (options.aad && !target.aad) {
      log(`${name}: no associated-data purpose, left as is`);
      report.targets[name] = { rewrapped: 0, skipped: 0, unreadable: [] };
      continue;
    }
    log(`${name} (${target.ring} ring, current key ${keyId(rings[target.ring])})`);
    const counts = await rewrapTarget(target, rings[target.ring], options);
    report.targets[name] = counts;
    log(
      `  ${options.dryRun ? 'would rewrap' : 'rewrapped'} ${counts.rewrapped}, unreadable ${counts.skipped}`
    );
  }
  log(`platform_settings.vapid_keys (token ring)`);
  report.vapid = options.aad
    ? { rewrapped: 0, skipped: 0, unreadable: [] }
    : await rewrapVapid(rings.token, options);
  log(
    `  ${options.dryRun ? 'would rewrap' : 'rewrapped'} ${report.vapid.rewrapped}, unreadable ${report.vapid.skipped}`
  );
  return report;
}
