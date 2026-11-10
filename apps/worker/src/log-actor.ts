/**
 * Naming the person behind a sweep, without ever risking the sweep.
 *
 * These lookups exist purely so a log line reads "Scott Eremia-Roden
 * (scott@example.com)" instead of "5b21a397a6d3c211bbc5f967". That is worth
 * a query and it is NOT worth an exception: indexing that fails because a
 * display name could not be resolved would be a spectacularly bad trade,
 * and a jest mock missing the export is enough to cause exactly that.
 *
 * So: total functions. Anything unexpected degrades to the id, which is
 * still the thing you would search on. The attribute shapes are the
 * vocabulary in docs/logging.md (`subject`/`user`/`email`/`actor`, and
 * `agentId`/`agent`/`owner…` for an agent); they are built here rather than
 * imported so a test that mocks `@renkei/db` down to `getDataStore` still
 * logs.
 */

import {
  describeAccountActor,
  describeActor,
  describeAgent,
  type Actor,
  type ActorFields,
  type AgentFields,
} from '@renkei/db';

function fallback(id: string | null | undefined): Actor {
  const name = id ?? '(none)';
  return { subject: name, displayName: name, email: null, label: name };
}

/** The Renkei user behind an OIDC subject. Never throws. */
export async function actorForSubject(subject: string | null | undefined): Promise<Actor> {
  try {
    return await describeActor(subject);
  } catch {
    return fallback(subject);
  }
}

/** The Renkei user behind a provider account id. Never throws. */
export async function actorForAccount(accountId: string | null | undefined): Promise<Actor> {
  try {
    return await describeAccountActor(accountId);
  } catch {
    return fallback(accountId);
  }
}

/** The person-shaped log attributes of an actor: spread them into a bag. */
export function actorFields(actor: Actor): ActorFields {
  return {
    subject: actor.subject,
    user: actor.displayName,
    email: actor.email,
    actor: actor.label,
  };
}

/** `{ subject, user, email, actor }` for a subject — the owner of a row in hand. */
export async function whoIs(subject: string | null | undefined): Promise<ActorFields> {
  return actorFields(await actorForSubject(subject));
}

/** The same for a provider account id (a Graph, Atlassian, Zoom or WebEx account). */
export async function whoHas(accountId: string | null | undefined): Promise<ActorFields> {
  return actorFields(await actorForAccount(accountId));
}

/**
 * An agent and the person it runs as, as log attributes. The row in hand
 * usually names the agent already (a run row, a loaded agent); without a
 * name the agent is read, and one that is gone logs as '(unknown agent)'.
 * Never throws.
 */
export async function whichAgentOf(row: {
  agentId: string;
  agentName?: string | null;
  ownerSubject: string | null | undefined;
}): Promise<AgentFields> {
  let agentName = row.agentName ?? null;
  if (!agentName) {
    try {
      agentName = (await describeAgent(row.agentId)).agentName;
    } catch {
      agentName = '(unknown agent)';
    }
  }
  const owner = await actorForSubject(row.ownerSubject);
  return {
    agentId: row.agentId,
    agent: agentName,
    ownerSubject: owner.subject,
    ownerName: owner.displayName,
    ownerEmail: owner.email,
    owner: owner.label,
  };
}
