/**
 * This delegate's identity (docs/delegate-key-design.md, "The delegate"):
 * an X25519 keypair and a `delegate_instances` row carrying the public
 * half with a heartbeat, so a browser knows which instances are alive and
 * what to seal a person's key to. A delegation is a key sealed to one
 * instance; this module is what makes this process that instance.
 *
 * Two kinds of instance:
 *
 *  - PERSISTENT, when DELEGATE_INSTANCE_KEY is set: the keypair is derived
 *    from that secret (never stored, never generated), so every boot and
 *    every replica with the same secret IS the same instance, under the
 *    same id. A restart or a rolling deploy keeps every delegation sealed
 *    to it: people's agents keep running while they are away. The row is
 *    never deleted; it is live while any replica heartbeats it.
 *  - EPHEMERAL, without it: a keypair generated at boot and held in memory
 *    only. On shutdown the row goes, and with it (cascade) every delegation
 *    sealed to this instance: those keys are gone with the process's
 *    memory, and a row nothing can open would only mislead. A restart is a
 *    fresh instance, and the web app tells the browser to seal again — but
 *    the agents of everyone who does not open the app pause until they do.
 *
 * What the secret buys and costs: with it, whoever holds the delegate's
 * environment can derive the instance key and open every delegation in the
 * database; without it, nothing on disk opens them, at the price above.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import {
  deviceCodeOf,
  generateX25519KeyPair,
  x25519KeyPairFromSecret,
  type X25519KeyPair,
} from '@renkei/crypto';
import { createKeyVault, setKeyVault, INSTANCE_LIVE_MS, type KeyVault } from '@renkei/user-keys';
import type { DelegateLogger } from './grants';

const HEARTBEAT_MS = 30_000;
/** A row whose heartbeat is this stale belongs to a process that died without saying so. */
const STALE_AFTER_MS = 5 * INSTANCE_LIVE_MS;

/** The environment variable a persistent instance's key is derived from. */
export const INSTANCE_KEY_ENV = 'DELEGATE_INSTANCE_KEY';
/** The compose file's development default: refused under NODE_ENV=production. */
export const DEVELOPMENT_INSTANCE_KEY = 'renkei-dev-delegate-instance-key';
const INSTANCE_KEY_INFO = 'renkei/delegate-instance/v1';

export interface DelegateInstance {
  vault: KeyVault;
  /** Whether this instance's key outlives the process (DELEGATE_INSTANCE_KEY). */
  persistent: boolean;
  /** Stop the heartbeat; an ephemeral instance also deletes its row. */
  retire(): Promise<void>;
}

/** The identity the environment gives this process: a persistent keypair, or none. */
export function instanceIdentityOf(
  env: NodeJS.ProcessEnv = process.env
): { id: string; pair: X25519KeyPair; persistent: true } | null {
  const secret = env[INSTANCE_KEY_ENV]?.trim();
  if (!secret) return null;
  const pair = x25519KeyPairFromSecret(secret, INSTANCE_KEY_INFO);
  return { id: instanceIdOf(pair.publicKey), pair, persistent: true };
}

/**
 * The persistent instance's id: a UUID spelled from the public key's hash,
 * so every replica derives the same one and a different key is a different
 * instance (a rotated secret starts afresh, as a restart used to).
 */
export function instanceIdOf(publicKey: Buffer): string {
  const digest = createHash('sha256').update(publicKey).digest();
  // RFC 4122 version and variant bits, so the id is a well-formed UUID.
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Why a production process must not boot with the development instance key. */
export function developmentInstanceKeyRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== 'production') return null;
  if (!env[INSTANCE_KEY_ENV]?.trim().startsWith(DEVELOPMENT_INSTANCE_KEY)) return null;
  return (
    `${INSTANCE_KEY_ENV} is the development default (${DEVELOPMENT_INSTANCE_KEY}) with NODE_ENV=production. ` +
    'Anyone with that string could open every delegation; set it from `openssl rand -base64 32`.'
  );
}

/** Register this process as a delegate instance and keep its heartbeat going. */
export async function registerInstance(
  logger: DelegateLogger,
  env: NodeJS.ProcessEnv = process.env
): Promise<DelegateInstance> {
  const identity = instanceIdentityOf(env);
  const id = identity?.id ?? randomUUID();
  const pair = identity?.pair ?? generateX25519KeyPair();
  const persistent = identity !== null;
  const instances = getDataStore().userKeys;
  await instances.registerInstance(id, pair.publicKey.toString('base64'));
  const vault = createKeyVault(id, pair);
  setKeyVault(vault);
  // The fingerprint is what a browser shows when it meets this instance's
  // key for the first time and asks the person; an operator compares it here.
  logger.info(
    persistent
      ? 'this delegate instance registered itself with key fingerprint {fingerprint}, the code a browser meeting it for the first time shows; its key is persistent, so delegations survive a restart'
      : 'this delegate instance registered itself with key fingerprint {fingerprint}, the code a browser meeting it for the first time shows',
    {
      component: 'worker-delegate/instance',
      instanceId: id,
      fingerprint: deviceCodeOf(new Uint8Array(pair.publicKey)),
    }
  );
  if (!persistent) {
    logger.warn(
      '{env} is not set: this instance key lives in memory only, and a restart drops every delegation sealed to it; the agents of everyone who does not open the app again pause until they do',
      { component: 'worker-delegate/instance', env: INSTANCE_KEY_ENV }
    );
  }

  const beat = async (): Promise<void> => {
    try {
      await instances.heartbeatInstance(id, new Date());
      // Rows of ephemeral instances that died without retiring. A persistent
      // instance's row is never stale while any replica beats it, and when
      // none does there is no one here to prune it.
      await instances.deleteStaleInstances(new Date(Date.now() - STALE_AFTER_MS));
    } catch (error) {
      logger.warn(
        "this delegate instance's heartbeat was not written; if it keeps failing the other instances treat it as dead and its delegations lapse: {error}",
        {
          component: 'worker-delegate/instance',
          instanceId: id,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  };
  const timer = setInterval(() => void beat(), HEARTBEAT_MS);
  timer.unref();

  return {
    vault,
    persistent,
    retire: async () => {
      clearInterval(timer);
      setKeyVault(null);
      // A persistent instance keeps its row: its key is the same on the
      // next boot, and another replica may be serving it right now.
      if (persistent) return;
      try {
        await instances.deleteInstance(id);
      } catch {
        // The stale sweep of another instance removes it.
      }
    },
  };
}
