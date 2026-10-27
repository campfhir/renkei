/**
 * The one key pair that signs every push this deployment sends.
 *
 * VAPID keys authenticate the SENDER to the push service (Apple's, Google's,
 * Mozilla's — whichever a subscriber's browser uses), not any one tenant or
 * person, so they live in `platform_settings` rather than per-tenant
 * storage. The public half is harmless to hand to any browser that asks
 * (see the vapid-public-key route); the private half is sealed with
 * `@renkei/crypto`'s envelope the same way `connector_configs` seals OAuth
 * secrets, under the deployment's TOKEN_ENCRYPTION_KEY.
 *
 * Generated on first use rather than requiring an operator to run a setup
 * step — same reasoning as the notification preferences defaulting rather
 * than requiring a migration to seed them.
 */

import { getDataStore } from '@renkei/db';
import webpush from 'web-push';
import { encrypt, decrypt } from '@renkei/crypto';

const SETTINGS_KEY = 'vapid_keys';

interface StoredVapidKeys {
  publicKey: string;
  encryptedPrivateKey: string;
}

function isStoredVapidKeys(value: unknown): value is StoredVapidKeys {
  return (
    typeof value === 'object' &&
    value !== null &&
    'publicKey' in value &&
    'encryptedPrivateKey' in value &&
    typeof value.publicKey === 'string' &&
    typeof value.encryptedPrivateKey === 'string'
  );
}

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

// One process, one pair, for the life of the process — decrypting on every
// send would mean every push paying for a query and a decrypt it doesn't
// need to.
let cached: VapidKeyPair | null = null;

/**
 * Reads the stored pair, or mints and stores one. The insert races on
 * `ON CONFLICT DO NOTHING` rather than upserting: two processes cold-starting
 * at once must not each write a DIFFERENT pair and leave the loser signing
 * with a key no subscription was ever created against (a subscription is
 * cryptographically bound to the public key the browser was given at
 * subscribe time). Whichever insert actually lands, every process re-reads
 * the row rather than trusting what it generated locally.
 */
export async function getVapidKeys(encryptionKey: Buffer): Promise<VapidKeyPair> {
  if (cached) return cached;

  const settings = getDataStore().platformSettings;
  const existing = await settings.get(SETTINGS_KEY);

  if (!existing) {
    const generated = webpush.generateVAPIDKeys();
    const stored: StoredVapidKeys = {
      publicKey: generated.publicKey,
      encryptedPrivateKey: encrypt(generated.privateKey, encryptionKey),
    };
    await settings.insertIfAbsent(SETTINGS_KEY, stored);
  }

  const row = await settings.get(SETTINGS_KEY);
  if (!row) throw new Error(`platform_settings.${SETTINGS_KEY} missing after insert`);

  if (!isStoredVapidKeys(row.value)) {
    throw new Error(`platform_settings.${SETTINGS_KEY} is malformed`);
  }
  const decrypted = decrypt(row.value.encryptedPrivateKey, encryptionKey);
  if (!decrypted.ok) {
    throw new Error('could not decrypt the stored VAPID private key');
  }

  cached = { publicKey: row.value.publicKey, privateKey: decrypted.val };
  return cached;
}

/** Test hook — also useful if the encryption key ever rotates. */
export function invalidateVapidKeyCache(): void {
  cached = null;
}
