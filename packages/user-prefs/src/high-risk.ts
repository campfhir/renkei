/**
 * A person's high-risk tools: the act tools that still wait for them when
 * something of theirs runs on its own. Two lists, kept apart because they
 * answer different questions:
 *
 *  - 'agents': an agent that accepts its own staged actions still has a
 *    person accept any batch holding one of these (@renkei/agents'
 *    act-approval.ts). Nothing is high risk by default — the organization's
 *    locked list is what covers mail, merges and deletes out of the box.
 *  - 'code': a code project's chat in Auto mode still stops and asks before
 *    calling one of these (apps/web's start-turn.ts). Everything is high
 *    risk by default except the work Auto mode exists for — the checkout's
 *    own tools (`code_*`: edit, commit, push, pull, run…), the sandbox's
 *    (`sandbox_*`) and the chat's own housekeeping (`chat_*`: its files,
 *    memories, title). A tool this build has never seen is high risk too.
 *
 * Stored as the person's departures from that default — `marked` (high risk
 * though the default says not) and `unmarked` (not, though the default says
 * so) — so a tool added later takes the default rather than whatever the
 * list looked like the day it was saved.
 *
 * Above both sits the organization's locked list (@renkei/settings'
 * lockedHighRiskTools): a locked tool is high risk whatever the person's
 * list says, and the page shows it checked and unchangeable.
 *
 * Pure: no database. index.ts holds the accessors; the Preferences page
 * renders from this half in the browser.
 */

export type HighRiskKind = 'agents' | 'code';

/** The user_preferences keys, one document per kind. */
export const HIGH_RISK_KEYS: Readonly<Record<HighRiskKind, string>> = {
  agents: 'agentHighRisk',
  code: 'codeHighRisk',
};

export interface HighRiskPrefs {
  /** High risk though the kind's default says not; sorted, unique. */
  marked: string[];
  /** Not high risk though the default says so; sorted, unique, never also in marked. */
  unmarked: string[];
}

export const DEFAULT_HIGH_RISK_PREFS: HighRiskPrefs = { marked: [], unmarked: [] };

/** Tool names as the model calls them. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,200}$/;

export function isToolName(value: unknown): value is string {
  return typeof value === 'string' && TOOL_NAME.test(value);
}

function names(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isToolName))].sort();
}

/**
 * Survives whatever jsonb hands back; anything unrecognisable is the
 * default. A name on both lists is marked: the safer answer wins.
 */
export function parseHighRiskPrefs(stored: unknown): HighRiskPrefs {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return DEFAULT_HIGH_RISK_PREFS;
  }
  const marked = names(Reflect.get(stored, 'marked'));
  const markedSet = new Set(marked);
  const unmarked = names(Reflect.get(stored, 'unmarked')).filter((name) => !markedSet.has(name));
  return { marked, unmarked };
}

/** Prefixes a code project's Auto mode runs without asking unless the person says otherwise. */
export const CODE_WORK_PREFIXES: readonly string[] = ['code_', 'sandbox_', 'chat_'];

/** Whether a tool is high risk before the person has said anything about it. */
export function highRiskByDefault(kind: HighRiskKind, name: string): boolean {
  if (kind === 'agents') return false;
  return !CODE_WORK_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Whether the organization holds this tool as high risk for everyone. */
export function isLockedHighRisk(locked: Iterable<string>, name: string): boolean {
  for (const entry of locked) if (entry === name) return true;
  return false;
}

/** Whether a tool is high risk for this person: locked, else their answer, else the default. */
export function isHighRisk(
  prefs: HighRiskPrefs,
  kind: HighRiskKind,
  name: string,
  locked: Iterable<string>
): boolean {
  if (isLockedHighRisk(locked, name)) return true;
  if (prefs.marked.includes(name)) return true;
  if (prefs.unmarked.includes(name)) return false;
  return highRiskByDefault(kind, name);
}

/**
 * The lists with one tool's answer changed. An answer that matches the
 * default is no departure, so it leaves both lists; anything else goes on
 * the one it departs to. Sorted and unique, like parse leaves them.
 */
export function withHighRisk(
  prefs: HighRiskPrefs,
  kind: HighRiskKind,
  name: string,
  highRisk: boolean
): HighRiskPrefs {
  const marked = prefs.marked.filter((entry) => entry !== name);
  const unmarked = prefs.unmarked.filter((entry) => entry !== name);
  if (highRisk !== highRiskByDefault(kind, name)) {
    (highRisk ? marked : unmarked).push(name);
  }
  return { marked: marked.sort(), unmarked: unmarked.sort() };
}

/**
 * A predicate over tool names, for a caller deciding many calls at once
 * (a turn, a staged batch). The locked list is read once into a set.
 */
export function highRiskTest(
  prefs: HighRiskPrefs,
  kind: HighRiskKind,
  locked: Iterable<string>
): (name: string) => boolean {
  const lockedSet = new Set(locked);
  const marked = new Set(prefs.marked);
  const unmarked = new Set(prefs.unmarked);
  return (name) =>
    lockedSet.has(name) ||
    marked.has(name) ||
    (!unmarked.has(name) && highRiskByDefault(kind, name));
}
