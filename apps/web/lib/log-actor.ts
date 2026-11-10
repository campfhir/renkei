/**
 * Who a log line is about, in the web app.
 *
 * Every line about something a person did carries the person: display
 * name, email and subject together (docs/logging.md). A route handler has
 * the session, which already describes its subject, so `who(session)` is
 * synchronous and free; a line about some other subject — the owner of a
 * shared agent, the grantor of a token — resolves it with `whoIs`, from the
 * same five-minute cache the workers use. An agent is named with its owner
 * by `whichAgent`.
 *
 * None of these throw: a line about someone the identity table does not
 * know names them by subject, which is still what you would search on.
 */

import {
  actorAttrs,
  actorFields,
  actorFrom,
  agentAttrs,
  agentAttrsFor,
  type ActorFields,
  type AgentFields,
} from '@renkei/db';
import type { Session } from '@/lib/session';

/**
 * The person behind a session, as log attributes: `{ subject, user, email,
 * actor }`. Tolerates a session built without `actor` (a test's stub) by
 * naming the subject.
 */
export function who(
  session: Pick<Session, 'subject'> & Partial<Pick<Session, 'actor'>>
): ActorFields {
  return actorFields(session.actor ?? actorFrom(session.subject, null, null));
}

/** The person behind a subject that is not the caller's. */
export const whoIs: (subject: string | null | undefined) => Promise<ActorFields> = actorAttrs;

/** An agent and the person it runs as. */
export const whichAgent: (agentId: string | null | undefined) => Promise<AgentFields> = agentAttrs;

/** The same, when the row in hand already names the agent and its owner. */
export const whichAgentOf = agentAttrsFor;
