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
import { sql, type Kysely } from 'kysely';
import type { DB, Json } from '@renkei/db';
import {
  blackoutPredicate,
  computeNextRunForSchedule,
  isAgentStepsDoc,
  isBlackoutEntry,
  parseScheduleConfig,
  serializeScheduleConfig,
  normalizeMatchForEvent,
  triggerEventById,
  type AgentStepsDoc,
  type BlackoutEntry,
  type TriggerDraft,
} from '@renkei/agents';
import { hashToken, generateSecret } from '@/lib/mcp-token';
import { isUuid } from '@/lib/uuid';

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
  steps: AgentStepsDoc;
  stepsVersion: number;
  llmModelId: string | null;
  enabled: boolean;
  /** Standing instructions injected into every run's model calls. */
  guardrails: string | null;
  /** Act tools the engine refuses for this agent's model-driven calls. */
  blockedTools: string[];
  createdAt: string;
  updatedAt: string;
  triggers: StoredTrigger[];
}

/** A freshly minted API key, surfaced exactly once. */
export interface MintedApiKey {
  triggerId: string;
  key: string;
}

interface TriggerRow {
  id: string;
  kind: string;
  event_source: string | null;
  event_type: string | null;
  config: Json;
  enabled: boolean;
  next_run_at: Date | null;
  last_fired_at: Date | null;
  last_error: string | null;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Row → draft. The row's config is our own write, but it round-trips
 * through jsonb, so read it defensively rather than trusting the cast.
 */
function draftOfRow(row: TriggerRow): { draft: TriggerDraft; keyHint: string | null } | null {
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
      const eventId = `${row.event_source}/${row.event_type}`;
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

async function triggersOf(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<StoredTrigger[]> {
  const rows = await db
    .selectFrom('agent_triggers')
    .select([
      'id',
      'kind',
      'event_source',
      'event_type',
      'config',
      'enabled',
      'next_run_at',
      'last_fired_at',
      'last_error',
    ])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .orderBy('created_at')
    .execute();
  return rows.flatMap((row) => {
    const parsed = draftOfRow(row);
    if (!parsed) return [];
    return [
      {
        id: row.id,
        draft: parsed.draft,
        enabled: row.enabled,
        lastFiredAt: iso(row.last_fired_at),
        lastError: row.last_error,
        nextRunAt: iso(row.next_run_at),
        keyHint: parsed.keyHint,
      },
    ];
  });
}

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  description_status: string;
  review_notes: Json | null;
  steps: Json;
  steps_version: number;
  llm_model_id: string | null;
  enabled: boolean;
  guardrails: string | null;
  blocked_tools: Json | null;
  created_at: Date;
  updated_at: Date;
}

/** blocked_tools jsonb → string[], defensively (it round-trips through jsonb). */
function blockedToolsOf(value: Json | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

async function toStored(
  db: Kysely<DB>,
  tenantId: string,
  row: AgentRow
): Promise<StoredAgent | null> {
  if (!isAgentStepsDoc(row.steps)) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    descriptionStatus: row.description_status,
    reviewNotes: row.review_notes,
    steps: row.steps,
    stepsVersion: row.steps_version,
    llmModelId: row.llm_model_id,
    enabled: row.enabled,
    guardrails: row.guardrails,
    blockedTools: blockedToolsOf(row.blocked_tools),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    triggers: await triggersOf(db, tenantId, row.id),
  };
}

const AGENT_COLUMNS = [
  'id',
  'name',
  'description',
  'description_status',
  'review_notes',
  'steps',
  'steps_version',
  'llm_model_id',
  'enabled',
  'guardrails',
  'blocked_tools',
  'created_at',
  'updated_at',
] as const;

export async function listAgents(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string
): Promise<StoredAgent[]> {
  const rows = await db
    .selectFrom('agents')
    .select(AGENT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .orderBy('created_at', 'desc')
    .execute();
  const agents: StoredAgent[] = [];
  for (const row of rows) {
    const stored = await toStored(db, tenantId, row);
    if (stored) agents.push(stored);
  }
  return agents;
}

export async function getAgent(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agentId: string
): Promise<StoredAgent | null> {
  // The id usually arrives from a URL; a malformed one (pasted link with
  // glued-on punctuation) is "no such agent", not a 22P02 → 500.
  if (!isUuid(agentId)) return null;
  const row = await db
    .selectFrom('agents')
    .select(AGENT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', agentId)
    .executeTakeFirst();
  return row ? toStored(db, tenantId, row) : null;
}

/**
 * The agent regardless of who is asking, plus who owns it. NOT an access
 * check — the only legitimate callers are the access resolver in
 * access-grants.ts (which admits a viewer only through an unexpired grant)
 * and code that has already proven ownership. Routes go through
 * resolveAgentAccess, never through this.
 */
export async function getAgentWithOwner(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string
): Promise<{ agent: StoredAgent; ownerSubject: string } | null> {
  if (!isUuid(agentId)) return null;
  const row = await db
    .selectFrom('agents')
    .select([...AGENT_COLUMNS, 'owner_subject'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', agentId)
    .executeTakeFirst();
  if (!row) return null;
  const agent = await toStored(db, tenantId, row);
  return agent ? { agent, ownerSubject: row.owner_subject } : null;
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
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  payloads: TriggerPayload[]
): Promise<MintedApiKey[]> {
  const existingRows = await db
    .selectFrom('agent_triggers')
    .select(['id', 'kind', 'config', 'next_run_at'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .execute();
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const keptIds = new Set<string>();
  const minted: MintedApiKey[] = [];

  // Resolve the org's calendars once for the whole reconcile: schedule
  // rows both verify their calendarId against this tenant's set (ownership
  // by construction — a foreign id silently resolves to no calendar) and
  // fold the dates into next_run_at.
  const calendars = new Map<string, BlackoutEntry[]>();
  if (payloads.some((payload) => payload.draft.kind === 'schedule')) {
    const rows = await db
      .selectFrom('schedule_calendars')
      .select(['id', 'dates'])
      .where('tenant_id', '=', tenantId)
      .execute();
    for (const row of rows) {
      calendars.set(row.id, Array.isArray(row.dates) ? row.dates.filter(isBlackoutEntry) : []);
    }
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
      if (payload.draft.kind === 'schedule' && match.next_run_at) {
        const stored = parseScheduleConfig(match.config);
        if (
          stored &&
          serializeScheduleConfig(stored) === fields.config &&
          match.next_run_at.getTime() > Date.now()
        ) {
          nextRunAt = match.next_run_at;
        }
      }
      await db
        .updateTable('agent_triggers')
        .set({
          event_source: fields.event_source,
          event_type: fields.event_type,
          config: fields.config,
          enabled: payload.enabled,
          next_run_at: nextRunAt,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', match.id)
        .where('tenant_id', '=', tenantId)
        .execute();
    } else {
      const id = randomUUID();
      keptIds.add(id);
      await db
        .insertInto('agent_triggers')
        .values({
          id,
          tenant_id: tenantId,
          agent_id: agentId,
          kind: payload.draft.kind,
          event_source: fields.event_source,
          event_type: fields.event_type,
          config: fields.config,
          enabled: payload.enabled,
          next_run_at: fields.next_run_at,
        })
        .execute();
      if (fields.mintedKey) minted.push({ triggerId: id, key: fields.mintedKey });
    }
  }

  const removed = existingRows.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
  if (removed.length > 0) {
    await db
      .deleteFrom('agent_triggers')
      .where('tenant_id', '=', tenantId)
      .where('id', 'in', removed)
      .execute();
  }

  return minted;
}

export interface SaveAgentInput {
  name: string;
  steps: AgentStepsDoc;
  triggers: TriggerPayload[];
  enabled: boolean;
  llmModelId: string | null;
  guardrails: string | null;
  blockedTools: string[];
}

export async function createAgent(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  input: SaveAgentInput
): Promise<{ agentId: string; apiKeys: MintedApiKey[] } | 'NAME_TAKEN'> {
  const agentId = randomUUID();
  try {
    await db
      .insertInto('agents')
      .values({
        id: agentId,
        tenant_id: tenantId,
        owner_subject: ownerSubject,
        name: input.name,
        steps: JSON.stringify(input.steps),
        llm_model_id: input.llmModelId,
        enabled: input.enabled,
        guardrails: input.guardrails,
        blocked_tools: JSON.stringify(input.blockedTools),
        description_status: 'stale',
      })
      .execute();
  } catch (error) {
    if (error instanceof Error && error.message.includes('agents_tenant_name')) {
      return 'NAME_TAKEN';
    }
    throw error;
  }
  const apiKeys = await reconcileTriggers(db, tenantId, agentId, input.triggers);
  return { agentId, apiKeys };
}

export async function updateAgent(
  db: Kysely<DB>,
  tenantId: string,
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
  try {
    const updated = await db
      .updateTable('agents')
      .set({
        name: input.name,
        steps: JSON.stringify(input.steps),
        steps_version: sql`steps_version + 1`,
        llm_model_id: input.llmModelId,
        enabled: input.enabled,
        guardrails: input.guardrails,
        blocked_tools: JSON.stringify(input.blockedTools),
        ...(options.markDescriptionStale === false ? {} : { description_status: 'stale' }),
        updated_at: sql`NOW()`,
      })
      .where('tenant_id', '=', tenantId)
      .where('owner_subject', '=', ownerSubject)
      .where('id', '=', agentId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 0) return 'NOT_FOUND';
  } catch (error) {
    if (error instanceof Error && error.message.includes('agents_tenant_name')) {
      return 'NAME_TAKEN';
    }
    throw error;
  }
  const apiKeys = await reconcileTriggers(db, tenantId, agentId, input.triggers);
  return { apiKeys };
}

/**
 * Shared-view lookup: the ONE read that is not keyed by owner. Holding
 * the link (plus a session in the tenant — the routes enforce that) IS
 * the authorization to read this agent's configuration for copying.
 */
export async function getAgentByShareToken(
  db: Kysely<DB>,
  tenantId: string,
  token: string
): Promise<StoredAgent | null> {
  if (!token) return null;
  const row = await db
    .selectFrom('agents')
    .select(AGENT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('share_token', '=', token)
    .executeTakeFirst();
  return row ? toStored(db, tenantId, row) : null;
}

/** The agent's current share token — owner only; 'NOT_FOUND' keeps the 404 rule. */
export async function readShareToken(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agentId: string
): Promise<string | null | 'NOT_FOUND'> {
  const row = await db
    .selectFrom('agents')
    .select('share_token')
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', agentId)
    .executeTakeFirst();
  if (!row) return 'NOT_FOUND';
  return row.share_token;
}

/** Set (mint/regenerate) or clear (null) the share token — owner only. */
export async function setShareToken(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agentId: string,
  token: string | null
): Promise<boolean> {
  const updated = await db
    .updateTable('agents')
    .set({ share_token: token, updated_at: sql`NOW()` })
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', agentId)
    .executeTakeFirst();
  return Number(updated.numUpdatedRows ?? 0) > 0;
}

export async function deleteAgent(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agentId: string
): Promise<boolean> {
  // Runs and steps cascade; triggers cascade. The FK graph is the delete.
  const result = await db
    .deleteFrom('agents')
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', agentId)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}

/** Persist a generated description; advisory, so failures are the caller's to log. */
export async function saveDescription(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  outcome:
    | { status: 'ok'; description: string; reviewNotes: { issue: string; fix?: string }[] }
    | { status: 'failed' }
): Promise<void> {
  if (outcome.status === 'ok') {
    await db
      .updateTable('agents')
      .set({
        description: outcome.description,
        review_notes: JSON.stringify(outcome.reviewNotes),
        description_status: 'ok',
        updated_at: sql`NOW()`,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', agentId)
      .execute();
  } else {
    await db
      .updateTable('agents')
      .set({ description_status: 'failed', updated_at: sql`NOW()` })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', agentId)
      .execute();
  }
}
