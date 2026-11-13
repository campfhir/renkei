/**
 * This instance, said to be up: its row in `sandbox_instances`, written
 * at boot and touched as it runs, so the app can send each caller's
 * calls to the one instance that serves them (packages/sandbox-client's
 * routing.ts, migration 179).
 *
 * `id` names the instance. It should outlive a restart wherever the
 * instance keeps its disk across one, because its callers stay assigned
 * to it by that name: SANDBOX_INSTANCE_ID when set, else the hostname —
 * stable for a restarted container and for a StatefulSet's pod, new for
 * a container made afresh. `address` is where the app reaches this
 * instance and no other: SANDBOX_WORKER_ADVERTISE_URL when set, else
 * each of its non-loopback IPv4 addresses on the listening port, for
 * the caller to try.
 *
 * Stopping does not take the row away. An instance that is restarting
 * is back within its callers' patience and still holds their checkouts;
 * one that is gone for good simply stops touching its row, and the app
 * moves its callers once the heartbeat is stale. Rows nobody has
 * touched for a day are cleared as a matter of housekeeping.
 */

import { hostname, networkInterfaces } from 'node:os';
import { getDataStore } from '@renkei/db';
import { logger } from './logger';

const COMPONENT = 'worker-sandbox/instance';
export const HEARTBEAT_INTERVAL_MS = 10_000;
const FORGET_AFTER_MS = 24 * 60 * 60_000;
/** One heartbeat in this many also clears long-dead rows. */
const HOUSEKEEPING_EVERY = 360;

/** This instance's name among the others. */
export function instanceId(): string {
  return process.env.SANDBOX_INSTANCE_ID?.trim() || hostname();
}

/**
 * This instance's own address, as the app reaches it: the one configured,
 * or every non-loopback IPv4 it has on the listening port, comma-
 * separated. An instance is often on more than one network (the app's,
 * and one of its own for its database) and cannot know which the app
 * shares with it, so it names them all and each caller uses the one that
 * answers (packages/sandbox-client routing.ts).
 */
export function advertisedAddress(port: number): string {
  const configured = process.env.SANDBOX_WORKER_ADVERTISE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const found: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        found.push(`http://${address.address}:${port}`);
      }
    }
  }
  return found.length > 0 ? found.join(',') : `http://127.0.0.1:${port}`;
}

/** Say this instance is up now and keep saying so; `stop` ends the saying. */
export function startInstanceHeartbeat(input: {
  id: string;
  address: string;
  intervalMs?: number;
}): { stop: () => void; beat: () => Promise<void> } {
  const startedAt = new Date();
  let beats = 0;
  let failing = false;
  const beat = async (): Promise<void> => {
    const now = new Date();
    try {
      const store = getDataStore().sandboxInstances;
      await store.heartbeat({ id: input.id, address: input.address, startedAt, at: now });
      beats += 1;
      if (beats % HOUSEKEEPING_EVERY === 1) {
        await store.removeUnseenSince(new Date(now.getTime() - FORGET_AFTER_MS));
      }
      if (failing) {
        failing = false;
        logger.info('sandbox instance {instance} is registered again at {address}', {
          component: COMPONENT,
          instance: input.id,
          address: input.address,
        });
      }
    } catch (error) {
      // Said once per outage: a database that is away says so every ten seconds otherwise.
      if (!failing) {
        failing = true;
        logger.warn(
          'sandbox instance {instance} could not say it is up: {error}; callers are sent elsewhere until it can',
          {
            component: COMPONENT,
            instance: input.id,
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), input.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), beat };
}
