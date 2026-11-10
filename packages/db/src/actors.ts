/**
 * Who did this, in words — for logs.
 *
 * A log line naming only `subject` ("5b21a397a6d3c211bbc5f967", an OIDC
 * subject or a provider account id) is unreadable to the person most likely
 * to be reading it, and a line naming only a display name cannot be joined
 * back to a row. So actor fields always come as ALL of: a name to read, an
 * email to recognise, and an id to search on.
 *
 * The log attribute vocabulary (docs/logging.md) is fixed here so every
 * process writes the same keys and the log search can filter on them:
 *
 *   person:  `subject`, `user` (display name), `email`, `actor` ("Name (email)")
 *   agent:   `agentId`, `agent` (name), `ownerSubject`, `ownerName`,
 *            `ownerEmail`, `owner` ("Name (email)")
 *
 * `actor` and `owner` are the two placeholders a message template uses:
 * each is always a defined string, so a line never prints a literal
 * `{email}` for a person whose email is not on record.
 *
 * Cached briefly because logging must never become a query amplifier — a
 * sweep touching fifty watches should not make fifty identity reads for
 * fifty lines about the same person.
 */

import { getDataStore } from './store/registry';

export interface Actor {
  /** The internal id — always present, always logged, always joinable. */
  subject: string;
  /** Display name, or the email, or the subject when nothing better exists. */
  displayName: string;
  /** The recorded email, or null when the subject has never signed in here. */
  email: string | null;
  /** `displayName (email)`, or whichever of the two exists — for messages. */
  label: string;
}

/** The person-shaped log attributes: spread them into any attribute bag. */
export interface ActorFields {
  subject: string;
  user: string;
  email: string | null;
  actor: string;
}

export interface AgentActor {
  agentId: string;
  /** The agent's name, or '(unknown agent)' when the row is gone. */
  agentName: string;
  owner: Actor;
}

/** The agent-shaped log attributes: the agent and the person it runs as. */
export interface AgentFields {
  agentId: string;
  agent: string;
  ownerSubject: string;
  ownerName: string;
  ownerEmail: string | null;
  owner: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 2_000;
/** People, by subject or by `account:<id>`. */
const people = new Map<string, CacheEntry<Actor>>();
/** Agents, by id. */
const agents = new Map<string, CacheEntry<AgentActor>>();

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  return undefined;
}

function remember<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): T {
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

const NOBODY: Actor = { subject: '(none)', displayName: '(none)', email: null, label: '(none)' };

/** Build an actor from what is known; the label never comes out empty. */
export function actorFrom(
  subject: string,
  displayName: string | null | undefined,
  email: string | null | undefined
): Actor {
  const name = displayName || email || subject;
  const mail = email || null;
  const label = mail && mail !== name ? `${name} (${mail})` : name;
  return { subject, displayName: name, email: mail, label };
}

/** Log attributes for a person. */
export function actorFields(actor: Actor): ActorFields {
  return {
    subject: actor.subject,
    user: actor.displayName,
    email: actor.email,
    actor: actor.label,
  };
}

/** Log attributes for an agent and its owner. */
export function agentFields(agent: AgentActor): AgentFields {
  return {
    agentId: agent.agentId,
    agent: agent.agentName,
    ownerSubject: agent.owner.subject,
    ownerName: agent.owner.displayName,
    ownerEmail: agent.owner.email,
    owner: agent.owner.label,
  };
}

/**
 * The actor for a subject. Never throws and never returns null: an
 * unresolvable identity still logs as its subject, because a log line that
 * disappears because a name lookup failed is worse than one with an ugly
 * name.
 */
export async function describeActor(subject: string | null | undefined): Promise<Actor> {
  if (!subject) return NOBODY;
  const hit = cached(people, subject);
  if (hit) return hit;

  let actor = actorFrom(subject, null, null);
  try {
    const identity = await getDataStore().identities.get(subject);
    if (identity) actor = actorFrom(subject, identity.displayName, identity.email);
  } catch {
    // Logging is never worth failing the work it describes.
  }
  return remember(people, subject, actor);
}

/**
 * The actor behind a PROVIDER account id (a Graph or Atlassian account),
 * which is what connector-side rows carry instead of a subject.
 */
export async function describeAccountActor(accountId: string | null | undefined): Promise<Actor> {
  if (!accountId) return NOBODY;
  const key = `account:${accountId}`;
  const hit = cached(people, key);
  if (hit) return hit;

  let actor = actorFrom(accountId, null, null);
  try {
    const grant = await getDataStore().providerGrants.findByAccount(accountId);
    if (grant?.subject) {
      actor = await describeActor(grant.subject);
    } else if (grant?.displayName) {
      actor = actorFrom(accountId, grant.displayName, null);
    }
  } catch {
    // As above: never fail the work for the sake of its log line.
  }
  return remember(people, key, actor);
}

/**
 * An agent by id, with its owner described: what a line about an agent's
 * run, trigger or action names instead of the agent id. A deleted agent
 * still logs, as '(unknown agent)' with nobody as owner.
 */
export async function describeAgent(agentId: string | null | undefined): Promise<AgentActor> {
  if (!agentId) return { agentId: '(none)', agentName: '(unknown agent)', owner: NOBODY };
  const hit = cached(agents, agentId);
  if (hit) return hit;

  let agent: AgentActor = { agentId, agentName: '(unknown agent)', owner: NOBODY };
  try {
    const row = await getDataStore().agents.find(agentId);
    if (row) {
      agent = { agentId, agentName: row.name, owner: await describeActor(row.ownerSubject) };
    }
  } catch {
    // As above.
  }
  return remember(agents, agentId, agent);
}

/** `actorFields(await describeActor(subject))`, for a call site in a hurry. */
export async function actorAttrs(subject: string | null | undefined): Promise<ActorFields> {
  return actorFields(await describeActor(subject));
}

/** `agentFields(await describeAgent(agentId))`. */
export async function agentAttrs(agentId: string | null | undefined): Promise<AgentFields> {
  return agentFields(await describeAgent(agentId));
}

/**
 * Agent fields when the row in hand already names the agent and its owner
 * (an agent-run row carries `agentName` and `ownerSubject`): one identity
 * read at most, no agent read.
 */
export async function agentAttrsFor(row: {
  agentId: string;
  agentName?: string | null;
  ownerSubject: string | null | undefined;
}): Promise<AgentFields> {
  if (!row.agentName) return agentAttrs(row.agentId);
  return agentFields({
    agentId: row.agentId,
    agentName: row.agentName,
    owner: await describeActor(row.ownerSubject),
  });
}

/** Drop what is cached about one subject (after a sign-in refreshed it). */
export function forgetActor(subject: string): void {
  people.delete(subject);
}

/** Drop what is cached about one agent (after a rename or delete). */
export function forgetAgent(agentId: string): void {
  agents.delete(agentId);
}

/** Test seam. */
export function resetActorCache(): void {
  people.clear();
  agents.clear();
}
