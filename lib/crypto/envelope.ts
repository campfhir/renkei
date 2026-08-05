/**
 * Envelope encryption, so a tenant's grants can be protected by a key of that
 * tenant's own.
 *
 * Two wire formats live side by side, and the version prefix in
 * `./secretbox.ts` exists for exactly this:
 *
 *   v1.<iv>.<tag>.<ciphertext>                    encrypted under the deployment key
 *   v2.<wrappedDek>.<iv>.<tag>.<ciphertext>       under a per-grant key, itself wrapped
 *
 * **Why a per-grant data key rather than encrypting straight under the tenant's
 * key.** One code path for both shapes of "bring your own key": a literal key the
 * tenant supplies, and — later — a KMS key the tenant holds and can revoke. Under
 * KMS the wrap becomes a call to the tenant's key vault instead of a local AES
 * operation, and nothing else about the format or the callers changes. Doing it
 * only when KMS arrives would mean re-encrypting every stored grant at that point.
 *
 * **Why v1 keeps working.** Rows written before a tenant supplied a key are still
 * readable: `openToken` dispatches on the prefix, so existing data does not need
 * a migration and a tenant can turn its own key on without a maintenance window.
 * Each grant moves to v2 the next time it is written, which for anyone actively
 * using a connector is within the hour, because Atlassian rotates refresh tokens
 * on every use.
 *
 * All parts are base64, and none of them can contain a `.` — which is why the
 * wrapped key is one binary blob rather than a nested v1 string.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { decrypt, encrypt } from './secretbox.js';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v2';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The keys available to a read or a write.
 *
 * `tenant` null means this tenant uses the deployment key, which is the shape a
 * single-organization deployment stays in forever.
 */
export interface KeySet {
  deployment: Buffer;
  tenant: Buffer | null;
}

/** Wraps a data key: iv ‖ tag ‖ ciphertext, as one blob. */
function wrapKey(dek: Buffer, kek: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function unwrapKey(blob: Buffer, kek: Buffer): Result<Buffer, 'DECRYPTION_ERROR'> {
  if (blob.byteLength !== IV_BYTES + TAG_BYTES + KEY_BYTES) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'malformed wrapped key',
    });
  }

  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, kek, iv);
    decipher.setAuthTag(tag);
    return ok(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch (cause) {
    // The authentication tag is what makes this the *right* failure: a grant
    // written under another tenant's key does not decrypt to garbage, it refuses.
    return err('DECRYPTION_ERROR' as const, {
      message: 'could not unwrap the data key (wrong tenant key?)',
      cause,
    });
  }
}

export function sealToken(plaintext: string, keys: KeySet): string {
  if (keys.tenant === null) {
    // No tenant key: the deployment key directly, in the format that has always
    // been written. A tenant that never asks for BYOK never pays for it.
    return encrypt(plaintext, keys.deployment);
  }

  const dek = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    VERSION,
    wrapKey(dek, keys.tenant).toString('base64'),
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export function openToken(payload: string, keys: KeySet): Result<string, 'DECRYPTION_ERROR'> {
  if (!payload.startsWith(`${VERSION}.`)) {
    // v1, or something malformed that `decrypt` will reject with its own message.
    return decrypt(payload, keys.deployment);
  }

  const parts = payload.split('.');
  if (parts.length !== 5) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'malformed ciphertext: expected 5 dot-separated parts',
    });
  }

  const [, wrapped, ivPart, tagPart, ciphertextPart] = parts;
  if (
    wrapped === undefined ||
    ivPart === undefined ||
    tagPart === undefined ||
    ciphertextPart === undefined
  ) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'malformed ciphertext: missing part',
    });
  }

  if (keys.tenant === null) {
    /**
     * A v2 row with no tenant key to open it with.
     *
     * This is the control working rather than a bug: the tenant's key has been
     * removed, or a KMS holding it is unreachable. It needs to be a specific
     * error with a runbook rather than a 500 that looks like a database problem.
     */
    return err('DECRYPTION_ERROR' as const, {
      message: 'this grant is encrypted under a tenant key that is not available — the tenant key was removed or its key service is unreachable',
    });
  }

  const dekResult = unwrapKey(Buffer.from(wrapped, 'base64'), keys.tenant);
  if (!dekResult.ok) {
    return dekResult;
  }
  const dek = dekResult.val;

  const iv = Buffer.from(ivPart, 'base64');
  const tag = Buffer.from(tagPart, 'base64');

  if (iv.byteLength !== IV_BYTES) {
    return err('DECRYPTION_ERROR' as const, {
      message: `malformed ciphertext: iv must be ${IV_BYTES} bytes`,
    });
  }
  if (tag.byteLength !== TAG_BYTES) {
    return err('DECRYPTION_ERROR' as const, {
      message: `malformed ciphertext: auth tag must be ${TAG_BYTES} bytes`,
    });
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, dek, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return ok(decrypted);
  } catch (cause) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'token decryption failed (wrong key or tampered payload)',
      cause,
    });
  }
}
