/**
 * Per-user keys for the specs that seed sealed rows straight into the
 * tables (docs/user-encryption-keys-design.md). Reproduced here with
 * node:crypto rather than imported from the packages, like the secretbox
 * the specs already carry, so Playwright's own transpilation never has to
 * resolve a workspace package.
 *
 * What a spec needs, and gets here:
 *   - `keyFor` — a chat's or project's data key, minted and wrapped for its
 *     owner exactly as the app does it (`resource_keys` + one
 *     `resource_key_grants` row), with a `seal` that writes the
 *     `renc2:<key id>:…` envelope every chat table carries;
 *   - `sealForSubject` — the `uenc1:` envelope a person's own value
 *     (an OAuth token, a connector credential) is stored under.
 *
 * The person's key-encryption key is HKDF(master, salt, tenant ‖ subject)
 * over the salt this helper upserts into `user_encryption_keys`; the
 * master is USER_KEY_ENCRYPTION_KEY, the one the delegate the Playwright
 * config starts runs with (docs/delegate-key-design.md).
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';

const KEK_INFO = 'renkei/user-kek/v1';

function master(): Buffer {
  const key = Buffer.from(process.env.USER_KEY_ENCRYPTION_KEY || '', 'base64');
  if (key.byteLength !== 32) {
    throw new Error(
      'USER_KEY_ENCRYPTION_KEY must decode to 32 bytes for the specs to seed sealed rows (the same value the delegate runs with).'
    );
  }
  return key;
}

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

/** The person's (managed) KEK, creating their salt row on first use. */
export async function userKek(client: Client, tenantId: string, subject: string): Promise<Buffer> {
  await client.query(
    `INSERT INTO user_encryption_keys (tenant_id, subject, salt)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, subject) DO NOTHING`,
    [tenantId, subject, randomBytes(32).toString('base64')]
  );
  const row = await client.query<{ salt: string }>(
    'SELECT salt FROM user_encryption_keys WHERE tenant_id = $1 AND subject = $2',
    [tenantId, subject]
  );
  const salt = Buffer.from(row.rows[0]!.salt, 'base64');
  const info = Buffer.from(`${KEK_INFO}\0${tenantId}\0${subject}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', master(), salt, info, 32));
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
  const kek = await userKek(client, input.tenantId, input.ownerSubject);
  const existing = await client.query<{ id: string; wrapped_key: string | null }>(
    `SELECT k.id, g.wrapped_key
       FROM resource_keys k
       LEFT JOIN resource_key_grants g ON g.resource_key_id = k.id AND g.subject = $3
      WHERE k.resource_kind = $1 AND k.resource_id = $2`,
    [input.kind, input.resourceId, input.ownerSubject]
  );
  let id: string;
  let key: Buffer;
  if (existing.rows[0]?.wrapped_key) {
    id = existing.rows[0].id;
    key = Buffer.from(openSecretbox(existing.rows[0].wrapped_key, kek), 'base64');
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
      `INSERT INTO resource_key_grants (resource_key_id, tenant_id, subject, wrapped_key, kek_version)
       VALUES ($1, $2, $3, $4, 1)`,
      [id, input.tenantId, input.ownerSubject, secretbox(key.toString('base64'), kek)]
    );
  }
  return { id, key, seal: (plaintext) => `renc2:${id}:${secretbox(plaintext, key)}` };
}

/** A person's own value, sealed directly under their KEK: `uenc1:…`. */
export async function sealForSubject(
  client: Client,
  tenantId: string,
  subject: string,
  plaintext: string
): Promise<string> {
  return `uenc1:${secretbox(plaintext, await userKek(client, tenantId, subject))}`;
}
