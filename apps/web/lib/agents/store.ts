/**
 * Persistence for user-drafted agents — the routes' shared data layer.
 *
 * Ownership is structural: every read and write is keyed by
 * (tenantId, ownerSubject), so someone else's agentId resolves to "not
 * found" rather than "forbidden" (the server-derived-authority rule the
 * tenant routes follow everywhere).
 *
 * Trigger updates RECONCILE rather than replace: rows the payload still
 * names (by id) are updated in place, which is what preserves an API
 * trigger's key hash and a schedule's fired-history across an unrelated
 * edit. A replaced-wholesale model would silently rotate every API key on
 * every save.
 *
 * API trigger keys are minted here, returned ONCE, and stored only as
 * SHA-256 digests (the mcp-token/log-ship pattern).
 */

import { randomUUID } from 'node:crypto';
import {
  getDatabase,
  getDataStore,
  type AgentRecord,
  type AgentTriggerChanges,
  type AgentTriggerRecord,
  type Json,
} from '@renkei/db';
import {
  blackoutPredicate,
  computeNextRunForSchedule,
  agentDefinitionOf,
  parseScheduleConfig,
  serializeScheduleConfig,
  normalizeMatchForEvent,
  triggerEventById,
  type BlackoutEntry,
  type TriggerDraft,
} from '@renkei/agents';
import { hashToken, generateSecret } from '@/lib/mcp-token';
import { isUuid } from '@/lib/uuid';
import { loadCalendarOptions } from '@/lib/schedule-calendars';

export interface TriggerPayload {
  /** Present when the builder is editing an existing trigger row. */
  id?: string;
  draft: TriggerDraft;
  enabled: boolean;
}

export interface StoredTrigger {
  id: string;
  draft: TriggerDraft;
  enabled: boolean;
  lastFiredAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  /** Last 4 chars of an API trigger's key, for display. */
  keyHint: string | null;
}

export interface StoredAgent {
  id: string;
  name: string;
  description: string | null;
  descriptionStatus: string;
  reviewNotes: Json | null;
  /** The structured instruction prompt the agent works from. */
  instructions: string;
  /** The tools it may use — reads called directly, acts staged for acceptance. */
  tools: string[];
  /** Counts saves, so run records can say which revision they ran. */
  revision: number;
  llmModelId: string | null;
  enabled: boolean;
  /** The owner's standing rules, injected into every run's model calls. */
  guardrails: string | null;
  /** Whether a run may pause and ask the owner a question (ask_person). */
  canAskQuestions: boolean;
  /** Whether staged actions are accepted without a person, where the org allows it. */
  autoAcceptActions: boolean;
  createdAt: string;
  updatedAt: string;
  triggers: StoredTrigger[];
}

/** A freshly minted API key, surfaced exactly once. */
export interface MintedApiKey {
  triggerId: string;
  key: string;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Row → draft. The row's config is our own write, but it round-trips
 * through jsonb, so read it defensively rather than trusting the cast.
 */
function draftOfRow(
  row: AgentTriggerRecord
): { draft: TriggerDraft; keyHint: string | null } | null {
  const config: {
    match?: unknown;
    callerAgentId?: unknown;
    inputs?: unknown;
    keyHint?: unknown;
  } =
    typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)
      ? row.config
      : {};
  switch (row.kind) {
    case 'event': {
      const eventId = `${row.eventSource}/${row.eventType}`;
      if (!triggerEventById(eventId)) return null;
      return {
        draft: {
          kind: 'event',
          eventId,
          // Re-parsed, not cast: jsonb strips the type on the way out, and a
          // row written by an older deploy (or by hand) must not be able to
          // hand the builder a shape it will then write back verbatim.
          match: normalizeMatchForEvent(eventId, config.match),
        },
        keyHint: null,
      };
    }
    case 'schedule': {
      // Re-validated on the way out: jsonb strips the type, and a malformed
      // row is dropped rather than thrown on. parseScheduleConfig also
      // upgrades the pre-042 single-recurrence shape in place.
      const parsed = parseScheduleConfig(row.config);
      if (!parsed) return null;
      return { draft: { kind: 'schedule', ...parsed }, keyHint: null };
    }
    case 'agent': {
      if (typeof config.callerAgentId !== 'string') return null;
      return { draft: { kind: 'agent', callerAgentId: config.callerAgentId }, keyHint: null };
    }
    case 'api': {
      const inputs = Array.isArray(config.inputs) ? config.inputs : [];
      return {
        draft: {
          kind: 'api',
          inputs: inputs.flatMap((input: unknown) => {
            if (typeof input !== 'object' || input === null) return [];
            const entry: { name?: unknown; label?: unknown } = input;
            return typeof entry.name === 'string' && typeof entry.label === 'string'
              ? [{ name: entry.name, label: entry.label }]
              : [];
          }),
        },
        keyHint: typeof config.keyHint === 'string' ? config.keyHint : null,
      };
    }
    default:
      return null;
  }
}

function storedTriggers(rows: AgentTriggerRecord[]): StoredTrigger[] {
  return rows.flatMap((row) => {
    const parsed = draftOfRow(row);
    if (!parsed) return [];
    return [
      {
        id: row.id,
        draft: parsed.draft,
        enabled: row.enabled,
        lastFiredAt: iso(row.lastFiredAt),
        lastError: row.lastError,
        nextRunAt: iso(row.nextRunAt),
        keyHint: parsed.keyHint,
      },
    ];
  });
}

function toStored(record: AgentRecord): StoredAgent {
  const definition = agentDefinitionOf(record);
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    descriptionStatus: record.descriptionStatus,
    reviewNotes: record.reviewNotes,
    instructions: definition.instructions,
    tools: definition.tools,
    revision: record.stepsVersion,
    llmModelId: record.llmModelId,
    enabled: record.enabled,
    guardrails: record.guardrails,
    canAskQuestions: record.canAskQuestions,
    autoAcceptActions: record.autoAcceptActions,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    triggers: storedTriggers(record.triggers),
  };
}

export async function listAgents(ownerSubject: string): Promise<StoredAgent[]> {
  return (await getDataStore().agents.list(ownerSubject)).map(toStored);
}

export async function getAgent(ownerSubject: string, agentId: string): Promise<StoredAgent | null> {
  // The id usually arrives from a URL; a malformed one (pasted link with
  // glued-on punctuation) is "no such agent", not a 22P02 → 500.
  if (!isUuid(agentId)) return null;
  const record = await getDataStore().agents.find(agentId, { ownerSubject });
  return record ? toStored(record) : null;
}

/**
 * The agent regardless of who is asking, plus who owns it. NOT an access
 * check — the only legitimate callers are the access resolver in
 * access-grants.ts (which admits a viewer only through an unexpired grant)
 * and code that has already proven ownership. Routes go through
 * resolveAgentAccess, never through this.
 */
export async function getAgentWithOwner(
  agentId: string
): Promise<{ agent: StoredAgent; ownerSubject: string } | null> {
  if (!isUuid(agentId)) return null;
  const record = await getDataStore().agents.find(agentId);
  return record ? { agent: toStored(record), ownerSubject: record.ownerSubject } : null;
}

/** One owner's agents as {id, name}, by name — name→id lookups that need no definitions. */
export async function listAgentNames(
  ownerSubject: string
): Promise<{ id: string; name: string }[]> {
  return getDataStore().agents.listNames(ownerSubject);
}

/** Every agent name matching `prefix%` (LIKE; the prefix's own wildcards act). */
export async function agentNamesLike(prefix: string): Promise<string[]> {
  return getDataStore().agents.namesLike(prefix);
}

/**
 * Extract the ScheduleConfig half of a schedule draft — the draft IS a
 * config plus the kind tag, but serializeScheduleConfig must never see the
 * tag or stray fields.
 */
function scheduleConfigOf(draft: Extract<TriggerDraft, { kind: 'schedule' }>) {
  const { kind: _kind, ...config } = draft;
  return config;
}

/** Draft → the row columns the trigger kind needs. */
function rowFieldsOf(
  draft: TriggerDraft,
  existing?: { keyHash?: string; keyHint?: string },
  /** Resolved org calendars, for schedule next_run_at computation. */
  calendars?: ReadonlyMap<string, BlackoutEntry[]>
): {
  event_source: string | null;
  event_type: string | null;
  config: string;
  next_run_at: Date | null;
  mintedKey: string | null;
} {
  switch (draft.kind) {
    case 'event': {
      const event = triggerEventById(draft.eventId);
      return {
        event_source: event?.source ?? null,
        event_type: event?.type ?? null,
        // Normalised on the way in too, so the stored form is canonical:
        // the fan-out compares against it on every inbound event and should
        // not be folding case or trimming entries in that hot path.
        config: JSON.stringify({ match: normalizeMatchForEvent(draft.eventId, draft.match) }),
        next_run_at: null,
        mintedKey: null,
      };
    }
    case 'schedule': {
      let config = scheduleConfigOf(draft);
      // A calendarId the tenant does not own resolves to nothing — drop it
      // rather than store a dangling (possibly cross-tenant) reference.
      if (config.calendarId && !calendars?.has(config.calendarId)) {
        const { calendarId: _dropped, ...rest } = config;
        config = rest;
      }
      const calendarDates = config.calendarId ? (calendars?.get(config.calendarId) ?? []) : [];
      return {
        event_source: null,
        event_type: null,
        config: serializeScheduleConfig(config),
        next_run_at: computeNextRunForSchedule(
          config,
          new Date(),
          blackoutPredicate(calendarDates)
        ),
        mintedKey: null,
      };
    }
    case 'agent':
      return {
        event_source: null,
        event_type: null,
        config: JSON.stringify({ callerAgentId: draft.callerAgentId }),
        next_run_at: null,
        mintedKey: null,
      };
    case 'api': {
      // Keep the existing key across edits; mint only for a new row.
      const key = existing?.keyHash ? null : generateSecret(32);
      const keyHash = existing?.keyHash ?? hashToken(key ?? '');
      const keyHint = existing?.keyHash ? (existing.keyHint ?? '') : (key ?? '').slice(-4);
      return {
        event_source: null,
        event_type: null,
        config: JSON.stringify({ inputs: draft.inputs, keyHash, keyHint }),
        next_run_at: null,
        mintedKey: key,
      };
    }
  }
}

/**
 * Reconcile the agent's trigger rows against the payload: update rows the
 * payload names, insert rows it does not, delete rows it no longer lists.
 *
 * Schedules get the keyHash treatment's sibling: when the schedule config
 * is UNCHANGED by the save (compared canonically) and the stored
 * next_run_at is still in the future, the stored value is preserved.
 * Recomputing on every save pushed a daily schedule's next fire to
 * tomorrow every time the agent was merely renamed.
 */
async function reconcileTriggers(
  agentId: string,
  payloads: TriggerPayload[]
): Promise<MintedApiKey[]> {
  const store = getDataStore().agents;
  const existingRows = await store.listTriggers(agentId);
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const keptIds = new Set<string>();
  const minted: MintedApiKey[] = [];
  const changes: AgentTriggerChanges = { update: [], insert: [], remove: [] };

  // Resolve the org's calendars once for the whole reconcile: schedule
  // rows both verify their calendarId against this tenant's set (ownership
  // by construction — a foreign id silently resolves to no calendar) and
  // fold the dates into next_run_at.
  const calendars = new Map<string, BlackoutEntry[]>();
  if (payloads.some((payload) => payload.draft.kind === 'schedule')) {
    for (const calendar of await scheduleCalendars()) calendars.set(calendar.id, calendar.dates);
  }

  for (const payload of payloads) {
    const existing = payload.id ? existingById.get(payload.id) : undefined;
    // A payload id that matches a different kind (or nothing) is treated as
    // a new trigger — ids are the builder's bookkeeping, not user input the
    // server bends the rules for.
    const match = existing && existing.kind === payload.draft.kind ? existing : undefined;
    const existingConfig: { keyHash?: unknown; keyHint?: unknown } =
      match &&
      typeof match.config === 'object' &&
      match.config !== null &&
      !Array.isArray(match.config)
        ? match.config
        : {};
    const fields = rowFieldsOf(
      payload.draft,
      {
        keyHash: typeof existingConfig.keyHash === 'string' ? existingConfig.keyHash : undefined,
        keyHint: typeof existingConfig.keyHint === 'string' ? existingConfig.keyHint : undefined,
      },
      calendars
    );

    if (match) {
      keptIds.add(match.id);
      // The unchanged-schedule check compares what WOULD be stored against
      // what IS stored, both in canonical form.
      let nextRunAt = fields.next_run_at;
      if (payload.draft.kind === 'schedule' && match.nextRunAt) {
        const stored = parseScheduleConfig(match.config);
        if (
          stored &&
          serializeScheduleConfig(stored) === fields.config &&
          match.nextRunAt.getTime() > Date.now()
        ) {
          nextRunAt = match.nextRunAt;
        }
      }
      changes.update.push({
        id: match.id,
        eventSource: fields.event_source,
        eventType: fields.event_type,
        config: fields.config,
        enabled: payload.enabled,
        nextRunAt,
      });
    } else {
      const id = randomUUID();
      keptIds.add(id);
      changes.insert.push({
        id,
        kind: payload.draft.kind,
        eventSource: fields.event_source,
        eventType: fields.event_type,
        config: fields.config,
        enabled: payload.enabled,
        nextRunAt: fields.next_run_at,
      });
      if (fields.mintedKey) minted.push({ triggerId: id, key: fields.mintedKey });
    }
  }

  changes.remove = existingRows.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
  await store.applyTriggerChanges(agentId, changes);
  return minted;
}

/**
 * The org's holiday calendars. They belong to the schedule-calendars
 * area, whose own loader reads them (loadCalendarOptions).
 */
async function scheduleCalendars(): Promise<{ id: string; dates: BlackoutEntry[] }[]> {
  const db = getDatabase();
  if (!db.ok) throw new Error(db.err.type);
  return loadCalendarOptions(db.val);
}

export interface SaveAgentInput {
  name: string;
  instructions: string;
  tools: string[];
  triggers: TriggerPayload[];
  enabled: boolean;
  llmModelId: string | null;
  guardrails: string | null;
  canAskQuestions: boolean;
  autoAcceptActions: boolean;
}

export async function createAgent(
  ownerSubject: string,
  input: SaveAgentInput
): Promise<{ agentId: string; apiKeys: MintedApiKey[] } | 'NAME_TAKEN'> {
  const agentId = randomUUID();
  const created = await getDataStore().agents.create({
    id: agentId,
    ownerSubject,
    ...definitionOf(input),
  });
  if (created === 'NAME_TAKEN') return 'NAME_TAKEN';
  const apiKeys = await reconcileTriggers(agentId, input.triggers);
  return { agentId, apiKeys };
}

function definitionOf(input: SaveAgentInput) {
  return {
    name: input.name,
    instructions: input.instructions,
    tools: input.tools,
    llmModelId: input.llmModelId,
    enabled: input.enabled,
    guardrails: input.guardrails,
    canAskQuestions: input.canAskQuestions,
    autoAcceptActions: input.autoAcceptActions,
  };
}

export async function updateAgent(
  ownerSubject: string,
  agentId: string,
  input: SaveAgentInput,
  options: {
    /**
     * False when the save changed nothing the summary describes (an on/off
     * toggle): the description stays as it is instead of going stale and
     * costing a model call.
     */
    markDescriptionStale?: boolean;
  } = {}
): Promise<{ apiKeys: MintedApiKey[] } | 'NOT_FOUND' | 'NAME_TAKEN'> {
  if (!isUuid(agentId)) return 'NOT_FOUND';
  const updated = await getDataStore().agents.update(ownerSubject, agentId, definitionOf(input), {
    markDescriptionStale: options.markDescriptionStale !== false,
  });
  if (updated !== 'UPDATED') return updated;
  const apiKeys = await reconcileTriggers(agentId, input.triggers);
  return { apiKeys };
}

export async function deleteAgent(ownerSubject: string, agentId: string): Promise<boolean> {
  if (!isUuid(agentId)) return false;
  // Runs and steps cascade; triggers cascade. The FK graph is the delete.
  return getDataStore().agents.delete(ownerSubject, agentId);
}

/** Persist a generated description; advisory, so failures are the caller's to log. */
export async function saveDescription(
  agentId: string,
  outcome:
    | { status: 'ok'; description: string; reviewNotes: { issue: string; fix?: string }[] }
    | { status: 'failed' }
): Promise<void> {
  await getDataStore().agents.saveDescription(
    agentId,
    outcome.status === 'ok'
      ? {
          status: 'ok',
          description: outcome.description,
          reviewNotes: outcome.reviewNotes.map((note) =>
            note.fix === undefined ? { issue: note.issue } : { issue: note.issue, fix: note.fix }
          ),
        }
      : { status: 'failed' }
  );
}

/** Mark the description stale — a re-describe is about to run and clients poll for it. */
export async function markDescriptionStale(agentId: string): Promise<void> {
  await getDataStore().agents.markDescriptionStale(agentId);
}
