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
 * An instance says where it is by every address it has, since it may be
 * on networks this process is not; the one that answers from here is the
 * one used. An instance that is up but answers on none of them cannot be
 * called from here, and the shared address is used instead — a call then
 * goes as it did before this, rather than nowhere.
 *
 * Where no instance has registered at all — a single worker from before
 * this, a development setup, the browser suite's stub — the shared
 * address (SANDBOX_WORKER_URL) is used, as it always was. A call made
 * for no caller (the worker's capabilities, the org's image rules) goes
 * there too: any instance answers those alike.
 *
 * WITH AN ORCHESTRATOR (SANDBOX_ORCHESTRATOR_URL and
 * SANDBOX_ORCHESTRATOR_API_KEY set; docs/sandbox-orchestrator-design.md)
 * none of the above applies. There are no shared instances to be assigned
 * to: each scope — a person, an agent, a code project — has a sandbox of
 * its own, and the orchestrator is asked where it is before a call
 * (`POST /v1/ensure`), which makes the sandbox on the first call, resumes
 * it when it was suspended, and answers its address and its own bearer
 * key. The answer is remembered for a few seconds; asking is also what
 * tells the orchestrator the scope is in use. A call made for no caller
 * goes to the `system` scope's sandbox. `sandboxConfig()` then names the
 * orchestrator, whose `/health` reports what sandboxes can do in the
 * worker's own shape.
 */

import { getDataStore } from '@renkei/db';
import { isRecord } from '@renkei/guards';

export interface SandboxEndpoint {
  /** The instance's base address, no trailing slash. */
  url: string;
  key: string;
  /**
   * What a call to this endpoint carries to be let in, when it is more
   * than the bearer key: an orchestrated sandbox behind an ingress that
   * wants its own token (Entra, on Azure) is called with that token as
   * `authorization` and the sandbox's key in `x-sandbox-key`. The
   * orchestrator answers these with the address; absent, the key is the
   * bearer.
   */
  headers?: Record<string, string>;
}

/** The headers that let a call in at `endpoint`. */
export function sandboxAuthHeaders(endpoint: SandboxEndpoint): Record<string, string> {
  return endpoint.headers ?? { authorization: `Bearer ${endpoint.key}` };
}

/** Header values from the orchestrator's answer: strings only, nothing else kept. */
function headersOf(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, header] of Object.entries(value)) {
    if (typeof header === 'string') out[name.toLowerCase()] = header;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** An instance whose heartbeat is older than this is taken for gone. */
export const SANDBOX_INSTANCE_LIVE_MS = 45_000;
/** How long a caller's instance is remembered in this process before it is looked up again. */
const CACHE_MS = 10_000;

const cache = new Map<
  string,
  { url: string; key?: string; headers?: Record<string, string>; until: number }
>();
/** Scopes whose last call did not connect: the orchestrator is told to check before answering. */
const suspect = new Set<string>();

/** The scope of calls made for no caller, as the orchestrator names it. */
const SYSTEM_ROUTE_KEY = 'system';
const ENSURE_TIMEOUT_MS = 150_000;

/** The orchestrator's address and key; null when sandboxes are not orchestrated. */
export function sandboxOrchestratorConfig(): SandboxEndpoint | null {
  const url = process.env.SANDBOX_ORCHESTRATOR_URL?.trim().replace(/\/+$/, '');
  const key = process.env.SANDBOX_ORCHESTRATOR_API_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

/** The shared address and the key every instance takes; null when the sandbox is not configured. */
export function sandboxConfig(): SandboxEndpoint | null {
  // Orchestrated: there is no shared worker; the orchestrator answers for them all.
  const orchestrator = sandboxOrchestratorConfig();
  if (orchestrator) return orchestrator;
  const url = process.env.SANDBOX_WORKER_URL?.trim().replace(/\/$/, '');
  const key = process.env.SANDBOX_WORKER_API_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

/** Test-only: forget every remembered instance. */
export function resetSandboxRoutingForTests(): void {
  cache.clear();
  reachable.clear();
  suspect.clear();
  chatProjects.clear();
}

/** A call to the caller's instance did not connect: look it up again next time. */
export function forgetSandboxEndpoint(subject: string | null | undefined): void {
  if (sandboxOrchestratorConfig()) {
    const key = subject || SYSTEM_ROUTE_KEY;
    cache.delete(key);
    suspect.add(key);
    return;
  }
  if (subject) cache.delete(subject);
}

/**
 * Where a call goes when the orchestrator could not say where the
 * scope's sandbox is: to the orchestrator's own `/unavailable/<why>`
 * path, which answers any request with that refusal in the sandbox
 * worker's error shape. So every caller's existing handling of a refused
 * call applies — "the sandbox is starting, try again" reaches a person
 * and a model as any other refusal does — and an orchestrator that is
 * down reads as the sandbox being unreachable, which it is.
 */
function unavailableEndpoint(orchestrator: SandboxEndpoint, why: string): SandboxEndpoint {
  return { url: `${orchestrator.url}/unavailable/${why}`, key: orchestrator.key };
}

async function orchestratedEndpoint(
  orchestrator: SandboxEndpoint,
  subject: string | null | undefined,
  now: number
): Promise<SandboxEndpoint> {
  const routeKey = subject || SYSTEM_ROUTE_KEY;
  const cached = cache.get(routeKey);
  if (cached && cached.key && cached.until > now) {
    return {
      url: cached.url,
      key: cached.key,
      ...(cached.headers ? { headers: cached.headers } : {}),
    };
  }
  let response: Response;
  try {
    response = await fetch(`${orchestrator.url}/v1/ensure`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${orchestrator.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ key: routeKey, ...(suspect.has(routeKey) ? { verify: true } : {}) }),
      signal: AbortSignal.timeout(ENSURE_TIMEOUT_MS),
    });
  } catch {
    // The request below fails the same way and says so.
    return unavailableEndpoint(orchestrator, 'provider');
  }
  if (!response.ok) {
    return unavailableEndpoint(orchestrator, response.status === 503 ? 'starting' : 'provider');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const url = isRecord(body) && typeof body.url === 'string' ? body.url.replace(/\/+$/, '') : '';
  const key = isRecord(body) && typeof body.key === 'string' ? body.key : '';
  if (!url || !key) return unavailableEndpoint(orchestrator, 'provider');
  const headers = isRecord(body) ? headersOf(body.headers) : undefined;
  suspect.delete(routeKey);
  cache.set(routeKey, { url, key, ...(headers ? { headers } : {}), until: now + CACHE_MS });
  return { url, key, ...(headers ? { headers } : {}) };
}

/** How long an instance's reachable address is remembered, and how long "none answered" is. */
const REACHABLE_MS = 5 * 60_000;
const UNREACHABLE_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_000;
const reachable = new Map<string, { url: string | null; until: number }>();

/**
 * The address this process can reach an instance at. An instance on
 * several networks advertises an address on each (comma-separated) and
 * cannot know which this process shares with it, so each is asked for
 * its `/health` and the first that answers is used and remembered. Null
 * when none answers: the instance is up (it says so in the database) but
 * not reachable from here.
 */
async function reachableUrl(
  instance: { id: string; address: string },
  now: number
): Promise<string | null> {
  const key = `${instance.id}\n${instance.address}`;
  const known = reachable.get(key);
  if (known && known.until > now) return known.url;
  const candidates = instance.address
    .split(',')
    .map((candidate) => candidate.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const answers = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const response = await fetch(`${candidate}/health`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return response.ok;
      } catch {
        return false;
      }
    })
  );
  const url = candidates[answers.indexOf(true)] ?? null;
  reachable.set(key, { url, until: now + (url ? REACHABLE_MS : UNREACHABLE_MS) });
  return url;
}

/** The first address an instance lists, for a call that must go to it whether or not it answers. */
function firstAddress(address: string): string {
  return (address.split(',')[0] ?? address).trim().replace(/\/+$/, '');
}

async function assignedAddress(subject: string, now: number): Promise<string | null> {
  const store = getDataStore().sandboxInstances;
  const liveSince = new Date(now - SANDBOX_INSTANCE_LIVE_MS);
  const current = await store.assignment(subject);
  if (current?.instance && current.instance.lastSeenAt.getTime() >= liveSince.getTime()) {
    const url = await reachableUrl(current.instance, now);
    if (url) return url;
    // Their instance says it is up but does not answer from here. If this
    // process reaches other instances, it is theirs that is in trouble (it
    // is restarting, say): the call goes to it all the same and fails,
    // rather than to another instance that holds nothing of theirs and
    // would quietly start everything again. Only a process that reaches no
    // instance at all — one on another network — uses the shared address.
    const others = (await store.listLive(liveSince)).filter(
      (instance) => instance.id !== current.instanceId
    );
    for (const other of others) {
      if (await reachableUrl(other, now)) return firstAddress(current.instance.address);
    }
    return others.length === 0 ? firstAddress(current.instance.address) : null;
  }
  const live = await store.listLive(liveSince);
  // Fewest callers first, among those this process can actually call.
  let choice: { id: string; url: string } | null = null;
  for (const instance of live) {
    const url = await reachableUrl(instance, now);
    if (url) {
      choice = { id: instance.id, url };
      break;
    }
  }
  if (!choice) {
    // Nobody reachable is saying they are up. The caller's own instance may
    // only be late with its heartbeat: prefer it to the shared address,
    // which would hand the call to an instance that holds nothing of theirs.
    return current?.instance ? reachableUrl(current.instance, now) : null;
  }
  const assigned = await store.assign({
    subject,
    instanceId: choice.id,
    replacing: current?.instanceId ?? null,
    at: new Date(now),
  });
  if (assigned === choice.id) return choice.url;
  // Another process chose first: go where the caller now is.
  const theirs = live.find((instance) => instance.id === assigned);
  return (theirs ? await reachableUrl(theirs, now) : null) ?? choice.url;
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
  const orchestrator = sandboxOrchestratorConfig();
  if (orchestrator) return orchestratedEndpoint(orchestrator, subject, now);
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
  const orchestrator = sandboxOrchestratorConfig();
  if (orchestrator) return runningSandboxes(orchestrator);
  const cfg = sandboxConfig();
  if (!cfg) return [];
  try {
    const live = await getDataStore().sandboxInstances.listLive(
      new Date(now - SANDBOX_INSTANCE_LIVE_MS)
    );
    const urls = await Promise.all(live.map((instance) => reachableUrl(instance, now)));
    const found = urls.filter((url): url is string => url !== null);
    if (found.length > 0) return found.map((url) => ({ url, key: cfg.key }));
  } catch {
    // The shared address, below.
  }
  return [cfg];
}

/**
 * Every sandbox that is running now, as the orchestrator lists them. A
 * suspended sandbox is not asked (and not woken): what only it could
 * answer — whose share link a token is — goes unanswered until a call
 * made for its scope resumes it.
 */
async function runningSandboxes(orchestrator: SandboxEndpoint): Promise<SandboxEndpoint[]> {
  try {
    const response = await fetch(`${orchestrator.url}/v1/list`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${orchestrator.key}`,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.sandboxes)) return [];
    const out: SandboxEndpoint[] = [];
    for (const entry of body.sandboxes) {
      if (!isRecord(entry) || typeof entry.url !== 'string' || typeof entry.key !== 'string') {
        continue;
      }
      const headers = headersOf(entry.headers);
      out.push({
        url: entry.url.replace(/\/+$/, ''),
        key: entry.key,
        ...(headers ? { headers } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** How long a chat's project is remembered: a chat moved between projects is noticed within this. */
const CHAT_PROJECT_CACHE_MS = 60_000;
const chatProjects = new Map<string, { route: string | null; until: number }>();

/**
 * The sandbox of the project a chat is in — `chat-project:<id>`, or
 * `code-project:<id>` for a code project — or null when the chat is in
 * none (or cannot be read: it is then served as its person's own).
 */
async function projectRouteOfChat(chatId: string, now: number): Promise<string | null> {
  const known = chatProjects.get(chatId);
  if (known && known.until > now) return known.route;
  let route: string | null = null;
  try {
    const store = getDataStore();
    const chat = await store.chats.get(chatId);
    const project = chat?.projectId ? await store.chatProjects.get(chat.projectId) : null;
    if (project) route = `${project.kind === 'code' ? 'code' : 'chat'}-project:${project.id}`;
  } catch {
    return null;
  }
  chatProjects.set(chatId, { route, until: now + CHAT_PROJECT_CACHE_MS });
  return route;
}

/**
 * The scope a call for `target` is served in: which sandbox.
 *
 * Its route when it names one (an agent's runs); else the caller's own.
 * With an orchestrator, a PROJECT has a sandbox of its own, and what is
 * done in a project is served there rather than in the sandbox of
 * whoever is doing it:
 *
 *  - a call in a code project's scratch space (`project:<id>`) goes to
 *    `code-project:<id>`, beside the checkout;
 *  - a call in a chat's scratch space (`chat:<id>`) goes to the sandbox
 *    of the project that chat is in, when it is in one — so a project
 *    shared with others never works inside one member's personal
 *    sandbox, and each member is still their own caller (their own uid,
 *    their own files) inside the project's.
 *
 * Who may work in a project at all is not decided here: the web app
 * checks that before it makes the call (lib/chat/access.ts), and nothing
 * else reaches a sandbox.
 */
export async function sandboxRouteKey(
  target: { subject: string; route?: string | null; scope?: string | null },
  now: number = Date.now()
): Promise<string> {
  if (target.route) return target.route;
  const scope = target.scope ?? '';
  if (!scope || target.subject.startsWith('code-project:') || !sandboxOrchestratorConfig()) {
    return target.subject;
  }
  if (scope.startsWith('project:')) return `code-project:${scope.slice('project:'.length)}`;
  if (scope.startsWith('chat:')) {
    return (await projectRouteOfChat(scope.slice('chat:'.length), now)) ?? target.subject;
  }
  return target.subject;
}

/**
 * Open a port of a scope's sandbox straight to the named people's own
 * browsers, each signing in as themselves (the orchestrator's
 * `/v1/expose`). The address, or null where there is no orchestrator or
 * its provider has no such door — the caller then serves the port as it
 * always did, through the web app. `emails` must come from the server's
 * own knowledge of who is signed in, never from a request body.
 */
export async function exposeSandboxPort(
  routeKey: string,
  port: number,
  emails: string[]
): Promise<{ ok: true; url: string | null } | { ok: false; message: string }> {
  const orchestrator = sandboxOrchestratorConfig();
  if (!orchestrator) return { ok: true, url: null };
  try {
    const response = await fetch(`${orchestrator.url}/v1/expose`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${orchestrator.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ key: routeKey, port, emails }),
      signal: AbortSignal.timeout(ENSURE_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = isRecord(body) && isRecord(body.error) ? body.error.message : null;
      return {
        ok: false,
        message: typeof error === 'string' ? error : `the orchestrator answered ${response.status}`,
      };
    }
    return { ok: true, url: isRecord(body) && typeof body.url === 'string' ? body.url : null };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Close a port opened with `exposeSandboxPort`. Best effort: a port left open closes with its sandbox. */
export async function unexposeSandboxPort(routeKey: string, port: number): Promise<void> {
  const orchestrator = sandboxOrchestratorConfig();
  if (!orchestrator) return;
  try {
    await fetch(`${orchestrator.url}/v1/unexpose`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${orchestrator.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ key: routeKey, port }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // Left open; it closes with the sandbox.
  }
}
