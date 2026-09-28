/**
 * The web process's own word that it is going down.
 *
 * `next start` closes its listener on SIGTERM/SIGINT and then waits for
 * every pending after() callback before it exits — and a chat turn IS an
 * after() callback that can legitimately run for hours (lib/code/turn.ts),
 * so without help the process sits there until the container's stop
 * timeout kills it outright, mid-tool-call, rows left `running`. This
 * module is the help: `installShutdownHandlers` listens for the same
 * signals (beside Next's own listener, which stays in place), and
 * everything long-lived registers with `onShutdown` — a turn runner
 * suspends itself (turn-runner.ts, resumed elsewhere by turn-recovery.ts),
 * an event stream closes so the listener can drain — and settles fast
 * enough that the process exits cleanly inside the grace period.
 *
 * On globalThis, like the turn channels and the logger: Next keeps
 * separate module graphs, and there is exactly one process shutting down.
 */

type ShutdownListener = () => void | Promise<void>;

interface ShutdownState {
  shuttingDown: boolean;
  listeners: Set<ShutdownListener>;
  installed: boolean;
}

declare global {
  var __renkeiShutdown: ShutdownState | undefined;
}

function state(): ShutdownState {
  return (globalThis.__renkeiShutdown ??= {
    shuttingDown: false,
    listeners: new Set(),
    installed: false,
  });
}

/** True once a termination signal has been seen (or beginShutdown called). */
export function isShuttingDown(): boolean {
  return state().shuttingDown;
}

/**
 * Runs `listener` when the process begins shutting down; returns the
 * unsubscribe. Registering after shutdown began runs it at once. A
 * listener may return a promise — beginShutdown waits for them all,
 * bounded — but must never throw: a failure is swallowed so one slow or
 * broken subscriber cannot keep the rest from settling.
 */
export function onShutdown(listener: ShutdownListener): () => void {
  const current = state();
  if (current.shuttingDown) {
    void Promise.resolve()
      .then(listener)
      .catch(() => {});
    return () => {};
  }
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
  };
}

/**
 * Tells every subscriber and waits for them, up to `waitMs`. Idempotent:
 * a second signal (Docker sends SIGTERM, then the shell's SIGINT, say)
 * changes nothing. Returns once the listeners have settled or the wait
 * ran out — never throws.
 */
export async function beginShutdown(waitMs = 5_000): Promise<void> {
  const current = state();
  if (current.shuttingDown) return;
  current.shuttingDown = true;
  const listeners = [...current.listeners];
  current.listeners.clear();
  const settled = Promise.allSettled(listeners.map((listener) => Promise.resolve().then(listener)));
  await Promise.race([settled, new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);
}

/**
 * Listens for SIGTERM/SIGINT once per process. Next's own handler on the
 * same signals closes the listener and waits for after() work; this one
 * runs beside it and is what makes that wait short.
 */
export function installShutdownHandlers(
  log: (signal: string) => void = () => {},
  waitMs = 5_000
): void {
  const current = state();
  if (current.installed) return;
  current.installed = true;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log(signal);
      void beginShutdown(waitMs);
    });
  }
}

/** Test hook: forgets listeners and the flag, as a fresh process would be. */
export function resetShutdownForTests(): void {
  globalThis.__renkeiShutdown = { shuttingDown: false, listeners: new Set(), installed: false };
}
