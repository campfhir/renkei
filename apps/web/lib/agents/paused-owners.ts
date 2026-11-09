/**
 * The people whose agents cannot run right now, for Agent oversight.
 *
 * An agent runs under its owner's automation delegation at the delegate
 * (docs/delegate-key-design.md). A person with an enabled agent and no
 * such delegation — they have not opened the app since the delegate's
 * instance changed, their window lapsed, they never enrolled a key — has
 * every scheduled run park as "sign in to resume", and until this list
 * existed nothing told an operator. The rows are built by a pure function
 * from what the store and the delegate answer, so the rules are tested
 * in node; `listPausedOwners` gathers the inputs.
 */

import { getDataStore } from '@renkei/db';
import { delegateClient } from '@renkei/delegate-client';
import { listAgentsForAdmin } from './runs-view';

/** What the delegate says about a person's keys, reduced to what the list needs. */
export interface OwnerKeySummary {
  enrolled: boolean;
  /** Live instances holding their automation delegation. */
  automationInstances: number;
  /** Live instances holding one of their session delegations. */
  sessionInstances: number;
}

export type PausedOwnerState =
  /** Enrolled, nothing delegated: their agents wait for their next visit. */
  | 'no-delegation'
  /** Only a session delegation: their agents stop when they sign out or it expires. */
  | 'session-only'
  /** No key at all: their agents cannot run until they enroll one by signing in. */
  | 'not-enrolled'
  /** The key service did not answer for them. */
  | 'unknown';

export interface PausedOwner {
  subject: string;
  email: string | null;
  displayName: string | null;
  /** Their enabled agents. */
  agents: number;
  state: PausedOwnerState;
  /** When they last used a session, ISO; null for never. */
  lastSeenAt: string | null;
  /** Their runs parked for sign-in right now. */
  parkedRuns: number;
}

export interface PausedOwnerInputs {
  agents: readonly { ownerSubject: string; ownerEmail: string | null; enabled: boolean }[];
  /** By subject; null when the delegate could not be asked. Absent subjects read as null. */
  statuses: ReadonlyMap<string, OwnerKeySummary | null>;
  lastSeen: ReadonlyMap<string, Date>;
  names: ReadonlyMap<string, { email: string; displayName: string | null }>;
  parked: ReadonlyMap<string, number>;
}

function stateOf(status: OwnerKeySummary | null | undefined): PausedOwnerState | null {
  if (!status) return 'unknown';
  if (status.automationInstances > 0) return null;
  if (!status.enrolled) return 'not-enrolled';
  if (status.sessionInstances > 0) return 'session-only';
  return 'no-delegation';
}

/**
 * Owners of at least one enabled agent whose agents cannot run unattended
 * right now, longest away first (never seen first; ties by subject). An
 * owner with a live automation delegation is left out: their agents run.
 */
export function pausedOwnersOf(input: PausedOwnerInputs): PausedOwner[] {
  const enabledByOwner = new Map<string, { count: number; email: string | null }>();
  for (const agent of input.agents) {
    if (!agent.enabled) continue;
    const entry = enabledByOwner.get(agent.ownerSubject) ?? { count: 0, email: agent.ownerEmail };
    entry.count += 1;
    entry.email ??= agent.ownerEmail;
    enabledByOwner.set(agent.ownerSubject, entry);
  }
  const rows: PausedOwner[] = [];
  for (const [subject, entry] of enabledByOwner) {
    const state = stateOf(input.statuses.get(subject));
    if (state === null) continue;
    const identity = input.names.get(subject);
    const lastSeen = input.lastSeen.get(subject);
    rows.push({
      subject,
      email: identity?.email ?? entry.email,
      displayName: identity?.displayName ?? null,
      agents: entry.count,
      state,
      lastSeenAt: lastSeen ? lastSeen.toISOString() : null,
      parkedRuns: input.parked.get(subject) ?? 0,
    });
  }
  return rows.sort((a, b) => {
    const at = a.lastSeenAt === null ? -Infinity : Date.parse(a.lastSeenAt);
    const bt = b.lastSeenAt === null ? -Infinity : Date.parse(b.lastSeenAt);
    if (at !== bt) return at < bt ? -1 : 1;
    return a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0;
  });
}

/** "3 weeks ago", "yesterday", "just now": how long since `iso`, read at `now`. */
export function agoText(iso: string | null, now: number): string {
  if (iso === null) return 'never';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (days < 60) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return `${months} months ago`;
}

/** What each state means, in the words the page shows. */
export function stateText(state: PausedOwnerState): string {
  switch (state) {
    case 'no-delegation':
      return 'Paused: their key is not delegated to the key service. Their agents run again once they open the app.';
    case 'session-only':
      return 'Runs only while they are signed in: their automation window has lapsed.';
    case 'not-enrolled':
      return 'Has not set up an encryption key: their agents cannot run until they sign in and do.';
    case 'unknown':
      return 'The key service did not answer for them.';
  }
}

async function keySummaryOf(subject: string): Promise<OwnerKeySummary | null> {
  const status = await delegateClient().keyStatus(subject);
  if (!status.ok) return null;
  return {
    enrolled: status.val.enrolled,
    automationInstances: status.val.automationInstances.length,
    sessionInstances: status.val.sessionInstances.length,
  };
}

/** How many waiting runs are read to count the parked ones; past this the count is a floor. */
const PARKED_SCAN = 1000;

/** The list, gathered: every agent's owner against the delegate, the session table and the queue. */
export async function listPausedOwners(): Promise<PausedOwner[]> {
  const agents = await listAgentsForAdmin();
  const owners = [...new Set(agents.filter((a) => a.enabled).map((a) => a.ownerSubject))];
  if (owners.length === 0) return [];
  const store = getDataStore();
  const [statuses, lastUsed, identities, waiting] = await Promise.all([
    Promise.all(owners.map(async (subject) => [subject, await keySummaryOf(subject)] as const)),
    store.sessions.lastUsedBySubject(),
    store.identities.listBySubjects(owners),
    store.agentRuns.listLiveForOrg({ statuses: ['waiting'], limit: PARKED_SCAN }),
  ]);
  const parked = new Map<string, number>();
  for (const run of waiting) {
    if (run.errorKind !== 'needs-sign-in') continue;
    parked.set(run.ownerSubject, (parked.get(run.ownerSubject) ?? 0) + 1);
  }
  return pausedOwnersOf({
    agents,
    statuses: new Map(statuses),
    lastSeen: new Map(lastUsed.map((row) => [row.subject, row.lastUsedAt])),
    names: new Map(
      identities.map((row) => [row.subject, { email: row.email, displayName: row.displayName }])
    ),
    parked,
  });
}
