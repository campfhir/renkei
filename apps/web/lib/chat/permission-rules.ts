/**
 * What a tool-permission preference IS, with no database in sight — the
 * half the Preferences form renders in the browser (permission-prefs.ts
 * holds the accessors, and reaches `pg`; a client component that imported
 * it would drag the database driver into the bundle, the same split
 * @renkei/user-prefs makes with its prefs.ts).
 *
 * Three answers per tool: ask (the default: the turn parks and the card
 * asks), allow (runs unasked), or deny (never offered to the model, and
 * refused if it calls the name from memory).
 */

/** Names are tool names as the model calls them: `jira_create_issue`, `chat_write_file`. */
export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,200}$/;

export interface ChatToolPermissionPrefs {
  /** Tool names that run without asking, sorted, unique. */
  alwaysAllow: string[];
  /** Tool names the chat may never call, sorted, unique; never also in alwaysAllow. */
  alwaysDeny: string[];
}

/** The three answers a person can give a tool ahead of time. */
export type ToolPermissionRule = 'ask' | 'allow' | 'deny';

export const DEFAULT_CHAT_TOOL_PERMISSION_PREFS: ChatToolPermissionPrefs = {
  alwaysAllow: [],
  alwaysDeny: [],
};

function names(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter((entry): entry is string => typeof entry === 'string' && TOOL_NAME.test(entry))
    ),
  ].sort();
}

/**
 * Survives whatever jsonb hands back; anything unrecognisable is "ask every
 * time". A name on both lists is blocked: the stricter answer wins, and a
 * page that let both be set for one tool would be a bug, not a choice.
 */
export function parseChatToolPermissionPrefs(stored: unknown): ChatToolPermissionPrefs {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return DEFAULT_CHAT_TOOL_PERMISSION_PREFS;
  }
  const raw: Record<string, unknown> = { ...stored };
  const alwaysDeny = names(raw.alwaysDeny);
  const denied = new Set(alwaysDeny);
  const alwaysAllow = names(raw.alwaysAllow).filter((name) => !denied.has(name));
  return { alwaysAllow, alwaysDeny };
}

/** What the person decided for one tool. */
export function ruleFor(prefs: ChatToolPermissionPrefs, name: string): ToolPermissionRule {
  if (prefs.alwaysDeny.includes(name)) return 'deny';
  if (prefs.alwaysAllow.includes(name)) return 'allow';
  return 'ask';
}

/** The lists with one tool's rule changed. */
export function withRule(
  prefs: ChatToolPermissionPrefs,
  name: string,
  rule: ToolPermissionRule
): ChatToolPermissionPrefs {
  return parseChatToolPermissionPrefs({
    alwaysAllow: [...prefs.alwaysAllow.filter((entry) => entry !== name)].concat(
      rule === 'allow' ? [name] : []
    ),
    alwaysDeny: [...prefs.alwaysDeny.filter((entry) => entry !== name)].concat(
      rule === 'deny' ? [name] : []
    ),
  });
}

/**
 * The shape the Preferences page lists tools in (permission-catalog.ts
 * builds it server-side): one group per connector, plus the two in-app
 * groups below.
 */
export interface ActToolEntry {
  name: string;
  label: string;
}

export interface ActToolGroup {
  /** The connector's capability key, or one of the two in-app keys below. */
  key: string;
  label: string;
  tools: ActToolEntry[];
}

export const CHAT_OWN_TOOLS_KEY = 'renkei-chat';
export const CODE_TOOLS_KEY = 'renkei-code';
