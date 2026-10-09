/**
 * Who may ask the delegate for what (docs/delegate-key-design.md,
 * "Callers"). Each calling process presents a bearer key of its own and
 * the key's name picks a row here; an op not on the row is refused before
 * the body is read. The lists are derived from the call sites — `grep
 * delegateClient\(\)\|delegateGrants\(\)\|grantFetch\(` in apps/worker and
 * apps/worker-agents, plus the fileshares client the queue worker's OCR
 * pipeline uses — and a caller that gains a call site gains an entry here,
 * with a test.
 *
 *   web      the web app: everything. It authenticates the person and is
 *            the only process a browser talks to.
 *   worker   the queue worker: a chat note's key (resource-key/ensure, which
 *            yields an automation wrapping for an unattended caller), a
 *            grant's description and the token proxy for webhook follow-up,
 *            file shares for the OCR pipeline.
 *   agents   the agents worker: whether a run's owner is delegated
 *            (keys/status) and the orphan-key prune.
 *   sandbox  the sandbox worker: nothing over the bearer surface — its git
 *            goes through the open /git/<ticket>/… proxy, where the ticket
 *            is the credential.
 *
 * Never for a worker, whatever its list says: keys/enroll, keys/shred,
 * keys/rotate, keys/delegate, resource-key/share, resource-key/delete,
 * grant/delete, oauth/exchange, and a write git ticket. A name that is not
 * here (a typo in DELEGATE_WORKER_API_KEYS) may run nothing.
 */

/** A list entry: an exact op, or a `prefix/*` family. */
type OpPattern = string;

export const CALLER_OPS: Readonly<Record<string, readonly OpPattern[] | 'all'>> = {
  web: 'all',
  worker: ['resource-key/ensure', 'grant/describe', 'api', 'forward/fileshares/*'],
  agents: ['keys/status', 'maintenance/prune-orphan-keys'],
  sandbox: [],
};

/** Ops no caller but the web app may ever run, whatever its row says. */
export const WEB_ONLY_OPS: ReadonlySet<string> = new Set([
  'keys/enroll',
  'keys/shred',
  'keys/rotate',
  'keys/delegate',
  'keys/revoke-automation',
  'resource-key/share',
  'resource-key/delete',
  'grant/delete',
  'grant/revoke',
  'grant/commit',
  'oauth/exchange',
  'grant/git-ticket',
]);

function matches(pattern: OpPattern, op: string): boolean {
  if (pattern.endsWith('/*'))
    return op.startsWith(pattern.slice(0, -1)) && op.length > pattern.length - 1;
  return pattern === op;
}

/** Whether the named caller may run `op`. Unknown callers may run nothing. */
export function callerMayRun(caller: string, op: string): boolean {
  const allowed = Object.prototype.hasOwnProperty.call(CALLER_OPS, caller)
    ? CALLER_OPS[caller]
    : null;
  if (allowed === null) return false;
  if (allowed === 'all') return true;
  if (WEB_ONLY_OPS.has(op)) return false;
  return allowed.some((pattern) => matches(pattern, op));
}

/** The bearer key the compose file ships for development; worthless in production. */
export const DEVELOPMENT_KEY = 'renkei-dev-delegate-key';

/**
 * Why the process must not start with these keys, or null when it may: the
 * development default under NODE_ENV=production is a key everyone has.
 */
export function developmentKeyRefusal(
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (env.NODE_ENV !== 'production') return null;
  if (!keys.some((key) => key === DEVELOPMENT_KEY)) return null;
  return (
    `the development delegate key (${DEVELOPMENT_KEY}) is configured with NODE_ENV=production. ` +
    'Set DELEGATE_WORKER_API_KEYS to a key per caller (web=…,worker=…,agents=…), each from `openssl rand -base64 32`.'
  );
}
