/**
 * This delegate's identity (docs/delegate-key-design.md, "The delegate"):
 * an X25519 keypair generated at boot and never written anywhere, and a
 * `delegate_instances` row carrying the public half with a heartbeat, so
 * a browser knows which instances are alive and what to seal a person's
 * key to. A delegation is a key sealed to one instance; this module is
 * what makes this process that instance.
 *
 * On shutdown the row goes, and with it (cascade) every delegation sealed
 * to this instance: those keys are gone with the process's memory, and a
 * row nothing can open would only mislead. A restart is therefore a
 * fresh instance, and the web app tells the browser to seal again.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { deviceCodeOf, generateX25519KeyPair } from '@renkei/crypto';
import { createKeyVault, setKeyVault, INSTANCE_LIVE_MS, type KeyVault } from '@renkei/user-keys';
import type { DelegateLogger } from './grants';

const HEARTBEAT_MS = 30_000;
/** A row whose heartbeat is this stale belongs to a process that died without saying so. */
const STALE_AFTER_MS = 5 * INSTANCE_LIVE_MS;

export interface DelegateInstance {
  vault: KeyVault;
  /** Stop the heartbeat and delete the row. */
  retire(): Promise<void>;
}

/** Register this process as a delegate instance and keep its heartbeat going. */
export async function registerInstance(
  db: Kysely<DB>,
  logger: DelegateLogger
): Promise<DelegateInstance> {
  const id = randomUUID();
  const pair = generateX25519KeyPair();
  await db
    .insertInto('delegate_instances')
    .values({ id, public_key: pair.publicKey.toString('base64') })
    .execute();
  const vault = createKeyVault(id, pair);
  setKeyVault(vault);
  // The fingerprint is what a browser shows when it meets this instance's
  // key for the first time and asks the person; an operator compares it here.
  logger.info('delegate instance {instanceId} registered, key fingerprint {fingerprint}', {
    component: 'worker-delegate/instance',
    instanceId: id,
    fingerprint: deviceCodeOf(new Uint8Array(pair.publicKey)),
  });

  const beat = async (): Promise<void> => {
    try {
      await db
        .updateTable('delegate_instances')
        .set({ heartbeat_at: new Date() })
        .where('id', '=', id)
        .execute();
      await db
        .deleteFrom('delegate_instances')
        .where('heartbeat_at', '<', new Date(Date.now() - STALE_AFTER_MS))
        .execute();
    } catch (error) {
      logger.warn('delegate heartbeat failed: {error}', {
        component: 'worker-delegate/instance',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const timer = setInterval(() => void beat(), HEARTBEAT_MS);
  timer.unref();

  return {
    vault,
    retire: async () => {
      clearInterval(timer);
      setKeyVault(null);
      try {
        await db.deleteFrom('delegate_instances').where('id', '=', id).execute();
      } catch {
        // The stale sweep of another instance removes it.
      }
    },
  };
}
