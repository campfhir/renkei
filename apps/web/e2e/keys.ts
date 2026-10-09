/**
 * Held keys for the specs that seed sealed rows straight into the tables
 * (docs/delegate-key-design.md). Reproduced here with node:crypto rather
 * than imported from the packages, like the secretbox the specs already
 * carry, so Playwright's own transpilation never has to resolve a
 * workspace package.
 *
 * A spec's person is ENROLLED the way their browser would do it: a user
 * key, an X25519 keypair and an automation key are generated here, the
 * latter two wrapped under the user key into `user_encryption_keys`, and
 * the user key (session) and automation key (automation) sealed to every
 * live delegate instance into `key_delegations` — the delegate the
 * Playwright config starts, which the specs then exercise for real. The
 * keys stay in this process so later seeding can wrap a chat's key for
 * the person and seal their own values.
 *
 * What a spec needs, and gets here:
 *   - `enrollForE2E` — the person's keys, enrolled once per (tenant, subject);
 *   - `keyFor` — a chat's or project's data key, minted and wrapped for its
 *     owner (`resource_keys` + one `user` grant), with a `seal` that writes
 *     the `renc2:<key id>:…` envelope every chat table carries;
 *   - `sealForSubject` — the `uenc1:` envelope a person's own value (an OAuth
 *     token, a connector credential) is stored under: their automation key.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { Client } from 'pg';

/** `@renkei/crypto`'s secretbox: `v1.<iv>.<tag>.<ciphertext>` (aes-256-gcm). */
export function secretbox(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

/** The inverse of `secretbox`, for reading a wrapping this helper wrote earlier. */
function openSecretbox(payload: string, key: Buffer): string {
  const [, iv, tag, ciphertext] = payload.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv!, 'base64'));
  decipher.setAuthTag(Buffer.from(tag!, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext!, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function x25519Pair(privateKey?: Buffer): { publicKey: Buffer; privateKey: Buffer } {
  if (privateKey) {
    const spki = createPublicKey(
      createPrivateKey({
        key: Buffer.concat([PKCS8_PREFIX, privateKey]),
        format: 'der',
        type: 'pkcs8',
      })
    ).export({ type: 'spki', format: 'der' });
    return { publicKey: Buffer.from(spki.subarray(spki.byteLength - 32)), privateKey };
  }
  const pair = generateKeyPairSync('x25519');
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
  return {
    publicKey: Buffer.from(spki.subarray(spki.byteLength - 32)),
    privateKey: Buffer.from(pkcs8.subarray(pkcs8.byteLength - 32)),
  };
}

/** `@renkei/crypto`'s sealed box: `sbox1:<ephemeral public>:<secretbox over base64(plaintext)>`. */
export function sealToPublicKey(recipientPublic: Buffer, plaintext: Buffer): string {
  const ephemeral = x25519Pair();
  const shared = diffieHellman({
    privateKey: createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, ephemeral.privateKey]),
      format: 'der',
      type: 'pkcs8',
    }),
    publicKey: createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, recipientPublic]),
      format: 'der',
      type: 'spki',
    }),
  });
  const info = Buffer.concat([
    Buffer.from('renkei/sealed-box/v1', 'utf8'),
    ephemeral.publicKey,
    recipientPublic,
  ]);
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, 32));
  return `sbox1:${ephemeral.publicKey.toString('base64')}:${secretbox(plaintext.toString('base64'), key)}`;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `@renkei/crypto`'s written-down form of a user key: 14 groups of 4 base32 characters, the last 4 a CRC checksum. */
export function formatUserKey(bytes: Buffer): string {
  let raw = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      raw += BASE32[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) raw += BASE32[(buffer << (5 - bits)) & 31];
  const top = crc32(bytes) >>> 12;
  raw +=
    BASE32[(top >> 15) & 31] +
    BASE32[(top >> 10) & 31] +
    BASE32[(top >> 5) & 31] +
    BASE32[top & 31];
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += 4) groups.push(raw.slice(i, i + 4));
  return groups.join('-');
}

/** `@renkei/crypto`'s device code and instance fingerprint: ten base32 characters of SHA-256, grouped in fives. */
export function deviceCodeOf(publicKey: Buffer): string {
  const digest = createHash('sha256').update(publicKey).digest();
  let raw = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      raw += BASE32[(buffer >> bits) & 31];
    }
  }
  const chars = raw.slice(0, 10).toUpperCase();
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

export interface E2EKeys {
  userKey: Buffer;
  automationKey: Buffer;
  publicKey: Buffer;
  privateKey: Buffer;
}

const enrolled = new Map<string, E2EKeys>();

/**
 * A person's keys are DERIVED from who they are, not drawn at random:
 * Playwright runs its workers as separate processes against one database,
 * and global-setup is a third, so a per-process cache alone would have the
 * second process to meet a person re-key them and strand every row the
 * first had sealed. The same (tenant, subject) yields the same keys in
 * every process; test keys, never a product secret.
 */
function keysOf(tenantId: string, subject: string): E2EKeys {
  const derive = (purpose: string): Buffer =>
    createHash('sha256').update(`renkei-e2e/${purpose}/${tenantId}/${subject}`).digest();
  return {
    userKey: derive('user-key'),
    automationKey: derive('automation-key'),
    ...x25519Pair(derive('private-key')),
  };
}

/** The delegate instances alive right now (the one the Playwright config started). */
async function liveInstances(client: Client): Promise<{ id: string; publicKey: Buffer }[]> {
  const rows = await client.query<{ id: string; public_key: string }>(
    `SELECT id, public_key FROM delegate_instances WHERE heartbeat_at > NOW() - interval '2 minutes'`
  );
  return rows.rows.map((row) => ({ id: row.id, publicKey: Buffer.from(row.public_key, 'base64') }));
}

/**
 * Enroll the person as their browser would, delegating to every live
 * instance for every session the person has (the spec's cookie session
 * among them). Idempotent per process: a second call returns the same
 * keys, and re-seals for any session added since.
 */
export async function enrollForE2E(
  client: Client,
  tenantId: string,
  subject: string,
  options: { automation?: boolean } = {}
): Promise<E2EKeys> {
  const cacheKey = `${tenantId}\0${subject}`;
  let keys = enrolled.get(cacheKey);
  if (!keys) {
    keys = keysOf(tenantId, subject);
    // Enrolled by another process already (global-setup, or the other
    // worker) under these same keys: nothing to write, and above all
    // nothing to delete — their wrappings and delegations stand.
    const current = await client.query<{ public_key: string | null; mode: string }>(
      `SELECT public_key, mode FROM user_encryption_keys WHERE tenant_id = $1 AND subject = $2`,
      [tenantId, subject]
    );
    const row = current.rows[0];
    if (row && row.mode === 'held' && row.public_key === keys.publicKey.toString('base64')) {
      enrolled.set(cacheKey, keys);
    }
  }
  if (!enrolled.has(cacheKey)) {
    await client.query(
      `INSERT INTO user_encryption_keys
         (tenant_id, subject, salt, mode, version, public_key, wrapped_private_key,
          wrapped_automation_key, enrolled_at)
       VALUES ($1, $2, $3, 'held', 1, $4, $5, $6, NOW())
       ON CONFLICT (tenant_id, subject) DO UPDATE SET
         mode = 'held', version = user_encryption_keys.version + 1, public_key = EXCLUDED.public_key,
         wrapped_private_key = EXCLUDED.wrapped_private_key,
         wrapped_automation_key = EXCLUDED.wrapped_automation_key, enrolled_at = NOW(),
         verifier = NULL, sealed_kek = NULL, unlocked_until = NULL`,
      [
        tenantId,
        subject,
        Buffer.alloc(32).toString('base64'),
        keys.publicKey.toString('base64'),
        secretbox(keys.privateKey.toString('base64'), keys.userKey),
        secretbox(keys.automationKey.toString('base64'), keys.userKey),
      ]
    );
    // Anything the person held under an earlier key (a rotation in
    // keys.spec.ts, a pre-derivation run) is unopenable under these; a
    // spec that seeds reseeds.
    await client.query(`DELETE FROM resource_key_grants WHERE tenant_id = $1 AND holder = $2`, [
      tenantId,
      subject,
    ]);
    await client.query(`DELETE FROM key_delegations WHERE tenant_id = $1 AND subject = $2`, [
      tenantId,
      subject,
    ]);
    enrolled.set(cacheKey, keys);
  }
  const instances = await liveInstances(client);
  if (instances.length === 0) {
    throw new Error(
      'No delegate instance is alive: the Playwright config starts one before the specs seed.'
    );
  }
  const sessions = await client.query<{ id: string; expires_at: Date }>(
    `SELECT id, expires_at FROM sessions WHERE tenant_id = $1 AND subject = $2`,
    [tenantId, subject]
  );
  for (const instance of instances) {
    for (const session of sessions.rows) {
      await client.query(
        `INSERT INTO key_delegations
           (tenant_id, subject, instance_id, scope, session_id, sealed_key, expires_at)
         SELECT $1::uuid, $2::text, $3::uuid, 'session', $4::uuid, $5::text, $6::timestamptz
          WHERE NOT EXISTS (
            SELECT 1 FROM key_delegations
             WHERE instance_id = $3::uuid AND session_id = $4::uuid AND scope = 'session')`,
        [
          tenantId,
          subject,
          instance.id,
          session.id,
          sealToPublicKey(instance.publicKey, keys.userKey),
          session.expires_at,
        ]
      );
    }
    if (options.automation !== false) {
      await client.query(
        `INSERT INTO key_delegations
           (tenant_id, subject, instance_id, scope, session_id, sealed_key, expires_at)
         SELECT $1::uuid, $2::text, $3::uuid, 'automation', NULL, $4::text, NOW() + interval '30 days'
          WHERE NOT EXISTS (
            SELECT 1 FROM key_delegations
             WHERE instance_id = $3::uuid AND tenant_id = $1::uuid AND subject = $2::text
               AND scope = 'automation')`,
        [tenantId, subject, instance.id, sealToPublicKey(instance.publicKey, keys.automationKey)]
      );
    }
  }
  return keys;
}

export interface SeededKey {
  id: string;
  key: Buffer;
  /** The `renc2` envelope the chat tables carry. */
  seal(plaintext: string): string;
}

/**
 * A chat's or project's key, wrapped for its owner — minted on the first
 * call and reused on every later one, so a seeding helper may ask once
 * per row and every row lands under the same key.
 */
export async function keyFor(
  client: Client,
  input: {
    tenantId: string;
    kind: 'chat' | 'chat_project';
    resourceId: string;
    ownerSubject: string;
  }
): Promise<SeededKey> {
  const keys = await enrollForE2E(client, input.tenantId, input.ownerSubject);
  const existing = await client.query<{ id: string; wrapped_key: string | null }>(
    `SELECT k.id, g.wrapped_key
       FROM resource_keys k
       LEFT JOIN resource_key_grants g
         ON g.resource_key_id = k.id AND g.holder_kind = 'user' AND g.holder = $3
      WHERE k.resource_kind = $1 AND k.resource_id = $2`,
    [input.kind, input.resourceId, input.ownerSubject]
  );
  let id: string;
  let key: Buffer;
  if (existing.rows[0]?.wrapped_key) {
    id = existing.rows[0].id;
    key = Buffer.from(openSecretbox(existing.rows[0].wrapped_key, keys.userKey), 'base64');
  } else {
    await client.query(`DELETE FROM resource_keys WHERE resource_kind = $1 AND resource_id = $2`, [
      input.kind,
      input.resourceId,
    ]);
    id = randomUUID();
    key = randomBytes(32);
    await client.query(
      `INSERT INTO resource_keys (id, tenant_id, resource_kind, resource_id) VALUES ($1, $2, $3, $4)`,
      [id, input.tenantId, input.kind, input.resourceId]
    );
    await client.query(
      `INSERT INTO resource_key_grants
         (resource_key_id, tenant_id, holder_kind, holder, wrapped_key, kek_version)
       VALUES ($1, $2, 'user', $3, $4, 1), ($1, $2, 'automation', $3, $5, 1)`,
      [
        id,
        input.tenantId,
        input.ownerSubject,
        secretbox(key.toString('base64'), keys.userKey),
        secretbox(key.toString('base64'), keys.automationKey),
      ]
    );
  }
  return { id, key, seal: (plaintext) => `renc2:${id}:${secretbox(plaintext, key)}` };
}

/** A person's own value, sealed under their automation key: `uenc1:…`. */
export async function sealForSubject(
  client: Client,
  tenantId: string,
  subject: string,
  plaintext: string
): Promise<string> {
  const keys = await enrollForE2E(client, tenantId, subject);
  return `uenc1:${secretbox(plaintext, keys.automationKey)}`;
}
