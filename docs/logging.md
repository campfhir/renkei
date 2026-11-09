# Logging: lines a reviewer can read

A log review answers "what happened to this person, this agent, this
connection?" from the lines alone. Every line therefore says, in words,
**who** did **what** to **which thing** and **what happened or did not** —
and carries, as attributes, the names and ids the log search filters on.

The logger is `@campfhir/bored-logs` (`apps/web/lib/logger.ts`,
`createWorkerLogger` in `packages/worker-kit`). A call is a message
template plus an attribute bag:

```ts
logger.info('{actor} resumed run {runId} of agent "{agent}"', {
  component: 'web/agents',
  ...who(session),
  ...(await whichAgent(agentId)),
  runId,
});
```

Two facts about the template decide how a line is written:

- **An attribute does not have to be in the message to be stored or
  searched.** Everything in the bag lands on the record (`subject:'auth0|…'`,
  `email:'ada@…'`, `agentId:'…'` all filter in the log search), whether or
  not the message mentions it. So ids go in the bag, and the message is
  free to read as a sentence.
- **A placeholder whose attribute is `undefined` is printed literally**
  (`{email}` stays `{email}`); `null` prints as `null`. A message may only
  reference keys that are always set — which is why the person and the
  agent each come with a label that is never empty (`{actor}`, `{owner}`).

## The vocabulary

Every process uses the same keys, so one search works everywhere
(`packages/db/src/actors.ts` defines them):

| About a person       | key       | value                                          |
| -------------------- | --------- | ---------------------------------------------- |
| id to join on        | `subject` | the OIDC subject                               |
| name to read         | `user`    | display name, else email, else the subject     |
| email to recognise   | `email`   | the recorded email, or `null` before a sign-in |
| the one for messages | `actor`   | `Ada Lovelace (ada@example.com)`, never empty  |

| About an agent       | key                                       | value                                            |
| -------------------- | ----------------------------------------- | ------------------------------------------------ |
| id to join on        | `agentId`                                 |                                                  |
| name to read         | `agent`                                   | the agent's name, `(unknown agent)` once deleted |
| the owner            | `ownerSubject`, `ownerName`, `ownerEmail` | as for a person                                  |
| the one for messages | `owner`                                   | `Ada Lovelace (ada@example.com)`                 |

Beside them, as before: `component` on every line (`web/agents`,
`worker-agents/engine`, `connectors/atlassian`, …), `error` for the
failure's message, and the ids of the things involved (`runId`, `chatId`,
`batchId`, `accountId`, an issue key).

### Getting them

- **Web, with a session:** `who(session)` (`apps/web/lib/log-actor.ts`) —
  synchronous; the session already carries its `actor`.
- **Web, another subject** (the owner of a shared agent, a token's
  grantor): `await whoIs(subject)`.
- **Web, an agent:** `await whichAgent(agentId)`, or `whichAgentOf(row)`
  when the row in hand already has `agentName` and `ownerSubject` (no
  agent read).
- **Workers and packages:** `actorAttrs(subject)`, `agentAttrs(agentId)`,
  `agentAttrsFor(row)` from `@renkei/db`; `describeAccountActor(accountId)`
  for a provider account id (a Graph or Atlassian account) and
  `actorFields(actor)` to turn it into attributes.
- **MCP tools:** `who(context)` — the tool context carries the caller's
  `actor` (the run OWNER when an agent is calling, with `agent` beside it).

All of them are total: a lookup that fails names the subject, and a
missing agent is `(unknown agent)`. Answers are cached for five minutes
per process, so a sweep over fifty rows about one person costs one read;
`forgetActor` / `forgetAgent` drop a stale entry after a sign-in or a
rename.

## Writing the message

1. **A sentence, with the person or agent as its subject.** `{actor}` for
   a person; `agent "{agent}" of {owner}` for an agent (the owner is who
   the agent acts as, and who to ask about it).
   - `{actor} deleted agent "{agent}"; its 3 queued runs were canceled`
   - `agent "{agent}" of {owner}: staged action {tool} failed: {error}`
2. **Names, not ids.** A subject, an agent id, a chat id or a grant id
   reads as noise; it is in the bag for the search. An id belongs in the
   message only when it is the handle a reader must follow — a run id
   that tells two runs of the same agent apart, an issue key, a batch —
   and then beside the name, not instead of it.
3. **Say what happened AND what did not.** The consequence is the point of
   a warn or error: `…; nothing was saved`, `…; the person saw a sign-in
error`, `…; the grant was not stored`, `…; will be tried again`,
   `…; dropped`. A reader should not have to open the code to know
   whether the thing went through.
4. **Name the thing the person worked on**, by what they would call it:
   the agent's name, the Jira issue key, the share's name, the file name,
   the connector ("the Microsoft 365 grant"), not the table or the type.
5. **The level says who should look.** `error`: something that should
   have happened did not, and someone has to act or the person is stuck.
   `warn`: degraded or skipped, but handled (a retry queued, a fallback
   used, a notification not sent). `info`: a state change a person or an
   agent caused — signed in, created, shared, deleted, a run finished.
   `debug`: the steps between, for a developer following one request.
6. **Errors end the line:** `…: {error}`, with `error` the message string
   (never the Error object, never a response body with secrets).
7. **No prefixes, no ids as the first word, no `Failed to` without the
   consequence.** `component` is an attribute, not a `[bracket]`.
8. **Secrets are wrapped** (`secure()`, `redact()`), never interpolated.
9. **Logging never fails the work.** The helpers above never throw; a
   call site resolves the actor with `await` where it already is async
   and falls back to `who(session)` elsewhere.

### Before and after

```ts
// before: an id, no outcome, no person
logger.error('The run could not be started: {error}', { component, subject, agentId, error });
// after
logger.error('{actor} asked agent "{agent}" to run, but no run was queued: {error}', {
  component: 'api/agents/invoke',
  ...who(session),
  ...(await whichAgent(agentId)),
  error,
});

// before
logger.info('Created', { component: 'auth/session', subject, roles });
// after
logger.info('{actor} signed in with roles {roles}; the session lasts until {expiresAt}', {
  component: 'auth/session',
  ...actorFields(actor),
  roles,
  expiresAt,
});

// before: a worker sweep naming a watch id
logger.warn('skipping {refId}: {reason}', { component, refId, accountId, reason });
// after
logger.warn(
  '{actor}: "{fileName}" was not indexed ({reason}); it will be skipped until it changes',
  {
    component,
    ...actorFields(await describeAccountActor(accountId)),
    refId,
    fileName,
    reason,
  }
);
```

## Tests

A test that checks a log line asserts the sentence and the attributes
that matter with `expect.objectContaining({ actor: …, agentId: … })`,
not the whole bag: the bag grows as context is added, the spec should
not break for that. Tests that stub a session give it an `actor`
(`actorFrom(subject, name, email)`) when the code under test logs; a
stub without one logs the subject, which `who()` tolerates.
