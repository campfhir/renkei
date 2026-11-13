/**
 * Which sandbox instance a caller's calls go to.
 *
 * The sandbox worker runs as several instances, and what an instance
 * holds for a caller — a notebook's kernel, a language server, a
 * preview, a browser session, and (once instances stop sharing a disk)
 * the checkouts — is that instance's alone. So every call made for a
 * caller goes to the ONE instance the caller is assigned to, at that
 * instance's own address, rather than to the shared address, which
 * hands each call to whichever instance it likes.
 *
 * Instances say they are up in `sandbox_instances` (the worker's
 * heartbeat); `sandbox_assignments` says which serves each caller. A
 * caller with no assignment is given the live instance serving the
 * fewest; a caller whose instance has stopped answering its heartbeat
 * is moved to another, and what the old one held is made again there —
 * a kernel starts fresh, a repository is cloned again. Two processes
 * deciding at once agree, because an assignment is only written when
 * nobody else has written one first.
 *
 * Where no instance has registered at all — a single worker from before
 * this, a development setup, the browser suite's stub — the shared
 * address (SANDBOX_WORKER_URL) is used, as it always was. A call made
 * for no caller (the worker's capabilities, the org's image rules) goes
 * there too: any instance answers those alike.
 */

import { getDataStore } from '@renkei/db';

export interface SandboxEndpoint {
  /** The instance's base address, no trailing slash. */
  url: string;
  key: string;
}

/** An instance whose heartbeat is older than this is taken for gone. */
export const SANDBOX_INSTANCE_LIVE_MS = 45_000;
/** How long a caller's instance is remembered in this process before it is looked up again. */
const CACHE_MS = 10_000;

const cache = new Map<string, { url: string; until: number }>();

/** The shared address and the key every instance takes; null when the sandbox is not configured. */
export function sandboxConfig(): SandboxEndpoint | null {
  const url = process.env.SANDBOX_WORKER_URL?.trim().replace(/\/$/, '');
  const key = process.env.SANDBOX_WORKER_API_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

/** Test-only: forget every remembered instance. */
export function resetSandboxRoutingForTests(): void {
  cache.clear();
}

/** A call to the caller's instance did not connect: look it up again next time. */
export function forgetSandboxEndpoint(subject: string | null | undefined): void {
  if (subject) cache.delete(subject);
}

async function assignedAddress(subject: string, now: number): Promise<string | null> {
  const store = getDataStore().sandboxInstances;
  const liveSince = new Date(now - SANDBOX_INSTANCE_LIVE_MS);
  const current = await store.assignment(subject);
  if (current?.instance && current.instance.lastSeenAt.getTime() >= liveSince.getTime()) {
    return current.instance.address;
  }
  const live = await store.listLive(liveSince);
  const choice = live[0];
  if (!choice) {
    // Nobody is saying they are up. The caller's own instance may only be
    // late with its heartbeat: prefer it to the shared address, which would
    // hand the call to an instance that holds nothing of theirs.
    return current?.instance?.address ?? null;
  }
  const assigned = await store.assign({
    subject,
    instanceId: choice.id,
    replacing: current?.instanceId ?? null,
    at: new Date(now),
  });
  // Another process may have chosen first: go where the caller now is.
  return (live.find((instance) => instance.id === assigned) ?? choice).address;
}

/**
 * Where to send a call made for `subject`: their instance's address, or
 * the shared one when there is no caller, no instance has registered, or
 * the assignments cannot be read (a call then still has somewhere to go).
 * Null when the sandbox is not configured.
 */
export async function sandboxEndpointFor(
  subject: string | null | undefined,
  now: number = Date.now()
): Promise<SandboxEndpoint | null> {
  const cfg = sandboxConfig();
  if (!cfg || !subject) return cfg;
  const cached = cache.get(subject);
  if (cached && cached.until > now) return { url: cached.url, key: cfg.key };
  let address: string | null;
  try {
    address = await assignedAddress(subject, now);
  } catch {
    return cfg;
  }
  // Remembered either way: with no instance registered the shared address
  // is the answer, and asking again on every call would be two reads each.
  const url = (address ?? cfg.url).replace(/\/$/, '');
  cache.set(subject, { url, until: now + CACHE_MS });
  return { url, key: cfg.key };
}

/** Every live instance's endpoint (the shared address when none has registered), for a question only one can answer. */
export async function sandboxEndpoints(now: number = Date.now()): Promise<SandboxEndpoint[]> {
  const cfg = sandboxConfig();
  if (!cfg) return [];
  try {
    const live = await getDataStore().sandboxInstances.listLive(
      new Date(now - SANDBOX_INSTANCE_LIVE_MS)
    );
    if (live.length > 0) {
      return live.map((instance) => ({ url: instance.address.replace(/\/$/, ''), key: cfg.key }));
    }
  } catch {
    // The shared address, below.
  }
  return [cfg];
}
