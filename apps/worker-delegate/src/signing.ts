/**
 * The deployment's instance-list signing key (docs/delegate-key-design.md,
 * "Which delegate am I sealing to?"). A browser seals a person's key to the
 * instance public keys the web app hands it; to accept an instance it has
 * never seen without asking the person, it wants that list signed by a key
 * it already trusts. One Ed25519 keypair per deployment does that: made by
 * the first delegate to boot, the public half in `delegate_signing_keys`
 * in the clear, the private half sealed under TOKEN_ENCRYPTION_KEY (an
 * org-level secret, as the connector client secrets already are), loaded
 * by every instance at boot and used to sign `keys/instances`.
 *
 * Honest limit: TOKEN_ENCRYPTION_KEY is also on the web app, so a web app
 * compromised together with the database can sign a list of its own. The
 * signed list closes the plain "swap the public key in the response" case;
 * the browser's trust-on-first-use and its dialog on an unknown key stand
 * on their own.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  decrypt,
  deviceCodeOf,
  encrypt,
  generateEd25519KeyPair,
  instanceListMessage,
  signEd25519,
  type SignedInstance,
} from '@renkei/crypto';
import type { DelegateLogger } from './grants';

export interface InstanceSigner {
  /** Raw Ed25519 public key, base64 — what a browser pins. */
  publicKey: string;
  /** A short fingerprint of it, the way the browser shows one, for the boot log. */
  fingerprint: string;
  /** The signature, base64, over `instanceListMessage(instances)`. */
  sign(instances: readonly SignedInstance[]): string;
}

/** The deployment's signing key, made on the first boot and read on every later one. */
export async function loadOrCreateSigningKey(
  db: Kysely<DB>,
  encryptionKey: Buffer,
  logger: DelegateLogger
): Promise<InstanceSigner | null> {
  let row = await db
    .selectFrom('delegate_signing_keys')
    .select(['public_key', 'sealed_private_key'])
    .executeTakeFirst();
  if (!row) {
    const pair = generateEd25519KeyPair();
    await db
      .insertInto('delegate_signing_keys')
      .values({
        public_key: pair.publicKey.toString('base64'),
        sealed_private_key: encrypt(pair.privateKey.toString('base64'), encryptionKey),
      })
      // Two instances booting at once: one row wins and both read it back.
      .onConflict((oc) => oc.column('singleton').doNothing())
      .execute();
    row = await db
      .selectFrom('delegate_signing_keys')
      .select(['public_key', 'sealed_private_key'])
      .executeTakeFirst();
    if (!row) return null;
  }
  const opened = decrypt(row.sealed_private_key, encryptionKey);
  if (!opened.ok) {
    logger.error(
      'the delegate signing key does not open under TOKEN_ENCRYPTION_KEY: instance lists go unsigned until it is replaced',
      { component: 'worker-delegate/signing' }
    );
    return null;
  }
  const privateKey = Buffer.from(opened.val, 'base64');
  const publicKey = Buffer.from(row.public_key, 'base64');
  if (privateKey.byteLength !== 32 || publicKey.byteLength !== 32) return null;
  const fingerprint = deviceCodeOf(new Uint8Array(publicKey));
  logger.info('delegate signing key {fingerprint} loaded', {
    component: 'worker-delegate/signing',
    fingerprint,
  });
  return {
    publicKey: row.public_key,
    fingerprint,
    sign: (instances) =>
      signEd25519(privateKey, Buffer.from(instanceListMessage(instances), 'utf8')).toString(
        'base64'
      ),
  };
}
