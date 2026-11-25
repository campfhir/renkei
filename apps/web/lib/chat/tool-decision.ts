/**
 * Whether one tool call in a chat runs, asks the person first, or is
 * refused — the whole rule in one place, with no database. A turn builds
 * the layers once (start-turn.ts) and the runner asks this for every call
 * (turn-runner.ts); the Tools dialog and the project's settings word their
 * rows from the same layers.
 *
 * A chat is one of three kinds of session, and the person's own lists are
 * kept per kind: an ordinary chat, a chat project's chat, a code project's
 * chat. (An agent is the fourth kind, decided by its own allowed actions:
 * @renkei/agents' act-approval.ts.) Tools the chat is not offered at all —
 * a connector turned off, a tool its toolset leaves out — never get here:
 * the surface does not offer them and the runner refuses them.
 *
 * In order, the first that applies decides:
 *
 *  1. Blocked — in this chat, or always by the person for this kind of
 *     session: refused. Nothing below lifts a block.
 *  2. Locked by the organization as high risk: asks, whatever anything
 *     below says.
 *  3. This chat says Ask (a read tool made to ask, or an act tool held back
 *     from an allow above it): asks. This chat says Allow: runs.
 *  4. The project (a chat project's or code project's own settings) says
 *     Ask: asks. Allow: runs.
 *  5. The person always allows it for this kind of session: runs.
 *  6. Nothing says anything: a read tool runs; an act tool asks — except
 *     in a code project's chat in Auto mode, where it runs unless the
 *     person marks it high risk (@renkei/user-prefs' high-risk.ts, 'code').
 */

export type ToolKind = 'read' | 'act';
export type ToolDecision = 'run' | 'ask' | 'refuse';

/** The kinds of chat session the person keeps separate lists for. */
export type ChatSessionKind = 'chat' | 'project' | 'code';

export interface ToolLayers {
  /** The organization's locked high-risk tools. */
  locked: ReadonlySet<string>;
  /** The person's own lists for this kind of session. */
  user: { allow: ReadonlySet<string>; deny: ReadonlySet<string> };
  /** The chat's project's settings; null outside a project. */
  project: { allow: ReadonlySet<string>; ask: ReadonlySet<string> } | null;
  /** This chat's own. */
  session: {
    allow: ReadonlySet<string>;
    deny: ReadonlySet<string>;
    ask: ReadonlySet<string>;
  };
  /** A code project's chat in Auto mode: whether the person marks a tool high risk there. */
  auto: { highRisk: (name: string) => boolean } | null;
}

export function decideTool(layers: ToolLayers, name: string, kind: ToolKind): ToolDecision {
  if (layers.session.deny.has(name) || layers.user.deny.has(name)) return 'refuse';
  if (layers.locked.has(name)) return 'ask';
  if (layers.session.ask.has(name)) return 'ask';
  if (layers.session.allow.has(name)) return 'run';
  if (layers.project?.ask.has(name)) return 'ask';
  if (layers.project?.allow.has(name)) return 'run';
  if (layers.user.allow.has(name)) return 'run';
  if (kind === 'read') return 'run';
  if (layers.auto) return layers.auto.highRisk(name) ? 'ask' : 'run';
  return 'ask';
}

/** Which layer decided, for a row that says why ("Allowed by the project"). */
export type DecidedBy =
  | 'blocked-here'
  | 'always-blocked'
  | 'locked'
  | 'ask-here'
  | 'allowed-here'
  | 'project-ask'
  | 'project-allow'
  | 'always-allowed'
  | 'default';

export function decidedBy(layers: ToolLayers, name: string): DecidedBy {
  if (layers.session.deny.has(name)) return 'blocked-here';
  if (layers.user.deny.has(name)) return 'always-blocked';
  if (layers.locked.has(name)) return 'locked';
  if (layers.session.ask.has(name)) return 'ask-here';
  if (layers.session.allow.has(name)) return 'allowed-here';
  if (layers.project?.ask.has(name)) return 'project-ask';
  if (layers.project?.allow.has(name)) return 'project-allow';
  if (layers.user.allow.has(name)) return 'always-allowed';
  return 'default';
}

/** No lists at all: what a fresh person in a fresh chat starts with. */
export function emptyLayers(): ToolLayers {
  const none = new Set<string>();
  return {
    locked: none,
    user: { allow: none, deny: none },
    project: null,
    session: { allow: none, deny: none, ask: none },
    auto: null,
  };
}
