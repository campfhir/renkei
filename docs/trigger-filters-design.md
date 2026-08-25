# Deterministic trigger filters — design

No code yet.

## Better news than expected

The mechanism already exists and has **no UI**.

`TriggerDraft` in `packages/agents/src/triggers.ts:36` already carries:

```ts
match?: { fromDomain?: string; subjectContains?: string }
```

and `fanOutAgentEvents` already applies it (`packages/agents/src/event-fanout.ts:60-70`,
called at `:107`) **before** a run is created — so before any model sees
anything. It is validated (`validateOne`, the `event` arm) and it is part of
the persisted trigger config.

Nothing in the builder renders it. `trigger-editor.tsx` has arms for `agent`,
`schedule` and `api`, and for `event` it renders one line of description text.
So a filter that exists, works, and is deterministic has been invisible since
it was written.

That makes this mostly a surfacing job, plus two widenings.

## What to add

Extend `MatchFilters`:

```ts
interface MatchFilters {
  /** Any number of exact sender addresses. Matches if ANY matches. */
  fromAddresses?: string[];
  /** Existing: the sender's domain. */
  fromDomain?: string;
  /** Existing: substring of the subject, case-insensitive. */
  subjectContains?: string;
  /** WebEx: only these spaces. Matches if the room is in the list. */
  roomIds?: string[];
}
```

Semantics to fix now, because they are the kind of thing that gets decided by
accident: **within a field, OR; between fields, AND.** Three sender addresses
means "from any of these three"; a sender list plus a subject filter means
both must hold. An empty or absent list means "no constraint", never "match
nothing" — the failure direction matters, and an agent that silently stops
firing is the worse outcome.

`webex/message.received` already provides `roomId` in its payload
(`trigger-catalog.ts:69`), so `roomIds` has something to match on with no
change to the emitting call site. `microsoft/mail.received` already provides
`from` and `subject`.

## The space picker

Filtering by `roomId` is useless if a person has to find the id themselves.
The picker needs a searchable list of the user's WebEx spaces.

`webex_list_rooms` exists as an MCP tool, but the builder is a web page and
cannot call the MCP endpoint. So: a route under
`app/api/tenant/[tenantId]/webex/rooms`, resolving the caller's own WebEx
grant, mirroring the shape the watch picker already uses
(`app/api/tenant/[tenantId]/watches/options`). Same reasoning as that picker's
doc comment: a typed key puts the user in the position the assistant was in —
guessing, and reading provider errors.

Search is server-side; a WebEx account can belong to hundreds of spaces.

## UI

`trigger-editor.tsx`, in the `event` arm, under the existing description: a
"Only when…" section whose fields depend on the event's connector.

- mail: sender addresses (chips, any number), sender domain, subject contains
- webex: spaces (chips from the picker)

The chip-with-× pattern is already there in `ApiInputsEditor` in the same
file, and now uses the shared compact `RemoveButton`.

## Why this is worth doing

The pitch is cost and predictability, and both are real:

- **Deterministic.** A WebEx agent scoped to two spaces cannot fire on a third,
  whatever a model would have decided. That is a guarantee, not a tendency.
- **Cheap.** The filter runs in `fanOutAgentEvents`, before a run row exists —
  a filtered event costs one comparison, not a run and a model call.
- **Per-agent.** It lives on the trigger, so two agents on the same event can
  watch different spaces, which is what "agent-based setting" means.

## Guard rails

- Cap the lists (say 25 entries each) and validate them like the existing
  `fromDomain` check. An unbounded list is a config that can DoS the fan-out
  path once it is on the hot path for every inbound event.
- Normalise addresses to lower case at save time, compare lower to lower — the
  existing `fromDomain` check already lowercases both sides, and an
  inconsistency here would be a filter that silently never matches.
- Test the **negative** direction explicitly: an event that must NOT fire. The
  existing tests cover matching; a filter bug that lets everything through
  looks exactly like no filter, and nothing downstream notices.
