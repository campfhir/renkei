/**
 * Keeping a person's cached tool list current without asking: when a server
 * advertises `tools.listChanged`, hold its notification stream and refresh
 * the list the moment it says the tools changed. A server that does not
 * advertise it (or offers no stream) is simply not watched — the timer
 * (`TOOL_LIST_TTL_MS`), the Refresh button and the refresh after a failed
 * call stand in, which is the whole fallback.
 *
 * A watch is one long-lived request through the delegate per (person,
 * server) in THIS process, so it exists only while it is wanted: started
 * when the person connects or their tool surface is resolved, and let go
 * once nothing has asked for it for `IDLE_MS`, on a sign-in failure, or
 * when the server is disabled, moved or deleted. Each replica watches for
 * itself; a refresh is idempotent, so two watchers do no harm.
 */

import {
  McpAuthRequired,
  getServer,
  watchToolListChanges,
  type McpServer,
} from '@renkei/connector-mcp';
import { logger } from '@/lib/logger';
import { mcpFetchFor, refreshToolList } from './remote';

/** Let go of a watch nothing has asked for in this long. */
export const IDLE_MS = 30 * 60_000;
/** The delegate ends a proxied request at its timeout; this is the longest it allows. */
const STREAM_TIMEOUT_MS = 10 * 60_000;
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** A server found not to announce changes is not asked again for this long. */
const UNSUPPORTED_MS = 60 * 60_000;

interface Watch {
  lastWanted: number;
  abort: AbortController;
}

const watches = new Map<string, Watch>();
const unsupportedUntil = new Map<string, number>();

const keyOf = (serverId: string, subject: string): string => `${serverId}:${subject}`;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** Whether the server still exists, is on, and is where the watch was opened. */
async function stillWanted(server: McpServer): Promise<McpServer | null> {
  const read = await getServer(server.id);
  if (!read.ok || !read.val || !read.val.enabled) return null;
  if (read.val.url !== server.url || read.val.transport !== server.transport) return null;
  return read.val;
}

async function run(server: McpServer, subject: string, watch: Watch) {
  const key = keyOf(server.id, subject);
  let backoff = MIN_BACKOFF_MS;
  try {
    while (!watch.abort.signal.aborted && Date.now() - watch.lastWanted < IDLE_MS) {
      const current = await stillWanted(server);
      if (!current) return;
      try {
        const outcome = await watchToolListChanges({
          url: current.url,
          transport: current.transport,
          fetch: mcpFetchFor(current, subject, { timeoutMs: STREAM_TIMEOUT_MS }),
          timeoutMs: 20_000,
          signal: watch.abort.signal,
          onChange: () => {
            void refreshToolList(current, subject).then((listed) => {
              if (!listed.ok) {
                logger.warn('MCP tool list refresh after a change notice failed: {reason}', {
                  component: 'mcp-servers',
                  server: current.slug,
                  reason: listed.reason,
                });
              }
            });
          },
        });
        if (outcome === 'unsupported') {
          unsupportedUntil.set(server.id, Date.now() + UNSUPPORTED_MS);
          return;
        }
        // A stream that ran its course is a healthy one: reconnect promptly.
        backoff = MIN_BACKOFF_MS;
      } catch (error) {
        if (error instanceof McpAuthRequired) return;
        logger.debug('MCP change stream dropped: {error}', {
          component: 'mcp-servers',
          server: server.slug,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(backoff, watch.abort.signal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  } finally {
    if (watches.get(key) === watch) watches.delete(key);
  }
}

/**
 * Make sure this process is listening for the person's tool changes on this
 * server, if it can. Cheap to call on every request: an existing watch just
 * has its idle clock reset, and a server known not to announce changes is
 * skipped.
 */
export function ensureWatching(server: McpServer, subject: string): void {
  const key = keyOf(server.id, subject);
  const existing = watches.get(key);
  if (existing) {
    existing.lastWanted = Date.now();
    return;
  }
  if ((unsupportedUntil.get(server.id) ?? 0) > Date.now()) return;
  const watch: Watch = { lastWanted: Date.now(), abort: new AbortController() };
  watches.set(key, watch);
  void run(server, subject, watch);
}

/** Stop listening for one person on one server (disconnect). */
export function stopWatching(serverId: string, subject: string): void {
  const key = keyOf(serverId, subject);
  watches.get(key)?.abort.abort();
  watches.delete(key);
}

/** Tests: forget everything. */
export function resetWatches(): void {
  for (const watch of watches.values()) watch.abort.abort();
  watches.clear();
  unsupportedUntil.clear();
}
