import type { PoolClient } from 'pg';
import { getPool } from './client';

const CHANNEL = 'agent_run_change';

/**
 * One process-wide `LISTEN agent_run_change` connection, fanned out to
 * per-run subscribers — the web app's side of the NOTIFY triggers added in
 * migration 078. A dedicated pool client (checked out and never released)
 * rather than one connection per subscriber: Postgres broadcasts a NOTIFY
 * to every listening session regardless of which one is asking, so a run
 * page open in two tabs — or on two web replicas behind a load balancer —
 * still only costs this process one held connection, not one per viewer.
 *
 * Anchored on globalThis for the same reason client.ts's pool is: Next
 * evaluates route handlers, middleware and instrumentation as separate
 * compilation graphs, and plain module state would mean one LISTEN
 * connection per graph instead of one per process.
 */
interface RunEventsState {
  client: PoolClient | null;
  connecting: Promise<PoolClient | null> | null;
  listeners: Map<string, Set<() => void>>;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const globalForRunEvents = globalThis as unknown as { __renkeiRunEventsState?: RunEventsState };
const state: RunEventsState = (globalForRunEvents.__renkeiRunEventsState ??= {
  client: null,
  connecting: null,
  listeners: new Map(),
});

function dispatch(runId: string): void {
  const subs = state.listeners.get(runId);
  if (!subs) return;
  for (const onChange of subs) onChange();
}

async function connect(): Promise<PoolClient | null> {
  const poolResult = getPool();
  if (!poolResult.ok) return null;
  try {
    const client = await poolResult.val.connect();
    client.on('notification', (message) => {
      if (message.channel === CHANNEL && message.payload) dispatch(message.payload);
    });
    // A dropped connection (Postgres restart, network blip) leaves nobody
    // LISTENing until something reconnects. Console, not a logger: this
    // package sits below every app's logging stack (see client.ts).
    client.on('error', (error) => {
      console.error(
        `[db] run-events connection lost (reconnecting): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      state.client = null;
      state.connecting = null;
      if (state.listeners.size > 0) void ensureClient();
    });
    await client.query(`LISTEN ${CHANNEL}`);
    return client;
  } catch (error) {
    console.error(
      `[db] run-events connect failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

async function ensureClient(): Promise<PoolClient | null> {
  if (state.client) return state.client;
  if (!state.connecting) {
    state.connecting = connect().then((client) => {
      state.client = client;
      state.connecting = null;
      return client;
    });
  }
  return state.connecting;
}

/**
 * Calls `onChange` (no payload — the caller re-reads whatever projection it
 * actually needs) whenever the given run's row, one of its step attempts,
 * or its pause card changes. Returns an unsubscribe function; the shared
 * LISTEN connection is established lazily on first use and left open for
 * the life of the process once it has subscribers.
 *
 * A caller with nothing to fall back on if this never fires (no DB
 * configured, the connect attempt failed) still gets a working
 * unsubscribe — the failure was already logged in `connect`.
 */
export async function subscribeToRunChanges(
  runId: string,
  onChange: () => void
): Promise<() => void> {
  await ensureClient();
  let subs = state.listeners.get(runId);
  if (!subs) {
    subs = new Set();
    state.listeners.set(runId, subs);
  }
  subs.add(onChange);
  return () => {
    subs?.delete(onChange);
    if (subs && subs.size === 0) state.listeners.delete(runId);
  };
}
