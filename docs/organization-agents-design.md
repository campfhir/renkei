# Organization agents — design

No code yet.

## The problem

Every agent has an `owner_subject` and runs on that person's OAuth grants. It
follows that an agent is only as durable as its author's employment: when they
leave and their grants are revoked, the agent stops, and the failure surfaces
as a token error on a schedule nobody is watching. There is also no way for a
second admin to edit an agent someone else made.

Wanted: agents owned by the organization, editable by any admin, running on
credentials that are nobody's personally.

## Approach: a service identity per agent

Confirmed direction. An org agent gets a **synthetic subject** that an admin
connects through the ordinary OAuth flow, so `provider_grants` is reused
unchanged and the agent survives any individual's departure.

The reason this is cheap: **the run engine already keys everything on
`owner_subject` and assumes nothing about it being human.** The MCP token is
minted for `run.owner_subject` (`engine.ts:836-840`), grants resolve by
subject, the actor description falls back to the id when no identity row
exists (`apps/worker/src/log-actor.ts` is explicitly total for this reason).
A subject that nobody signs in as flows through untouched.

### Shape

```
agents.owner_kind  'user' | 'org'   default 'user'
```

with `owner_subject` holding, for an org agent, a synthetic value:

```
org:<tenantId>:<agentId>
```

Derived, not random, so it is reconstructible from the row and reads as what
it is in a log line. It must be **impossible to mint as a session subject** —
the OIDC callback takes `sub` straight from the id_token, so the `org:` prefix
needs an explicit rejection there. Without that, an IdP that could be induced
to issue `sub: "org:…"` would hand someone an org agent's grants. Cheap check;
serious consequence.

An `identities` row for the synthetic subject gives it a display name
("Service desk agent (organization)"), so the People page, the run logs and
the audit trail all name it rather than printing a uuid triple.

### Connecting it

The existing OAuth flow already writes `provider_grants` keyed by subject. The
only change is _which_ subject the callback records — the connect link for an
org agent carries the agent's service subject rather than the session's.

That has to be authorized carefully: an operator initiating the flow is
consenting **with their own provider account** to grant access that will
outlive their session and be used by other admins. The consent screen belongs
to the provider, but the page that starts it must say plainly whose account is
about to be linked and that the resulting access is the organization's, not
theirs. This is the one place in the feature where a user could be surprised
by what they authorized, so it is worth being wordy.

Revocation stays where it is: the People page already lists grants with a
disconnect control, and an org agent's grants should appear there too — under
the service identity, not hidden.

## Visibility and editing

- Listing (`lib/agents/store.ts` `listAgents`) filters by `owner_subject =
session.subject`. Org agents are the exception: any operator sees them.
- `getAgent` guards the same way and gains the same exception.
- Editing, enabling, deleting and manual runs: operators only.
- Non-operators do not see org agents at all. They act with credentials the
  viewer does not control, and listing them without the ability to inspect
  what they do would be worse than not listing them.

The existing agent share-token flow (`share-agent.tsx`) is unaffected and
should stay off org agents in the first cut — a shareable link to an agent
running on org credentials is a separate decision.

## Audit

Every mutation of an org agent goes through `lib/audit.ts` naming the acting
operator. For a personal agent the owner and the actor are the same person and
the row is nearly redundant; for an org agent they are structurally different,
and "who changed the thing that runs on the org's credentials" is the question
the audit log exists to answer.

## What is deliberately not in scope

- **Per-agent permission narrowing.** An org agent gets whatever the linked
  account got. Narrowing beyond that is the connector-access-control work, and
  the two should not be entangled.
- **Automatic re-consent.** When an org agent's grant expires or is revoked, it
  fails like any other. It should fail _loudly_ — the existing
  `agent-run-failed` handler emails the owner, and for an org agent that needs
  to reach operators instead of a subject with no mailbox. **This is the one
  place the "nobody signs in as this subject" property breaks something**, and
  it needs handling in the first cut rather than after the first silent
  failure.

## Migration

One migration: `owner_kind` on `agents` with a default, plus an index on
`(tenant_id, owner_kind)` for the listing query. Existing rows are `'user'` by
the default and every current code path keeps working unchanged.

## Tests worth having

1. An org agent runs, and the MCP token is minted for the service subject —
   not for whoever triggered it.
2. A non-operator cannot see, edit or run an org agent, by route and not only
   by absence from the list.
3. The OIDC callback refuses an id_token whose `sub` starts with `org:`.
4. A failed org-agent run notifies operators rather than dead-lettering a
   message to a subject with no mailbox.
