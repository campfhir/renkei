/**
 * Renkei's own scope space — distinct from the Atlassian scopes, which are
 * fixed for the whole deployment and never chosen per client.
 *
 * Two scopes, and the split is the same one READ_ONLY enforces: a session
 * granted only `jira:read` gets the read tools registered and nothing else, so
 * the mutating tools are absent from that client's `tools/list` rather than
 * present and refusing. One mechanism, two ways to reach it — deployment-wide
 * via config, or per-session via the scope the client asked for.
 *
 * A deployment running READ_ONLY caps everyone: `jira:write` cannot be granted
 * at all, so a client that requests it is told so at the authorization
 * endpoint rather than discovering it when a tool is missing.
 */

export const SCOPE_READ = 'jira:read';
export const SCOPE_WRITE = 'jira:write';

export const ALL_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;

export type RenkeiScope = (typeof ALL_SCOPES)[number];

export function isRenkeiScope(value: string): value is RenkeiScope {
  return (ALL_SCOPES as readonly string[]).includes(value);
}

/** Scopes this deployment is willing to grant at all. */
export function supportedScopes(readOnly: boolean): RenkeiScope[] {
  return readOnly ? [SCOPE_READ] : [...ALL_SCOPES];
}

export function parseScope(raw: string | null | undefined): string[] {
  return (raw ?? '').split(/\s+/).filter(Boolean);
}

export function formatScope(scopes: readonly string[]): string {
  return scopes.join(' ');
}

export interface ScopeDecision {
  granted: RenkeiScope[];
  /** Names the client asked for that this deployment will not grant. */
  refused: string[];
}

/**
 * Resolves what a client actually gets.
 *
 * An empty request means "everything this deployment offers", which is what
 * clients that do not model scopes send. An unknown or unavailable scope is
 * reported rather than quietly dropped: a client that asked for `jira:write`
 * on a read-only deployment needs to know it did not get it, and the
 * difference between "not granted" and "silently ignored" is the difference
 * between a clear error and a confusing missing tool.
 */
export function resolveScopes(requested: readonly string[], readOnly: boolean): ScopeDecision {
  const available = supportedScopes(readOnly);

  if (requested.length === 0) {
    return { granted: available, refused: [] };
  }

  const granted = available.filter((scope) => requested.includes(scope));
  const refused = requested.filter((scope) => !(available as string[]).includes(scope));

  // Write without read is not a coherent tool surface — every write tool's
  // description tells the model to read first. Asking for write implies read.
  if (granted.includes(SCOPE_WRITE) && !granted.includes(SCOPE_READ)) {
    granted.unshift(SCOPE_READ);
  }

  return { granted, refused };
}
