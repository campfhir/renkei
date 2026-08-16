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
  computeNextRun,
  isAgentStepsDoc,
  isRecurrence,
  triggerEventById,
  type AgentStepsDoc,
  type TriggerDraft,
} from '@renkei/agents';
import { hashToken, generateSecret } from '@/lib/mcp-token';

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
    match?: { fromDomain?: string; subjectContains?: string };
    recurrence?: unknown;
    timezone?: unknown;
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
        draft: { kind: 'event', eventId, match: config.match },
        keyHint: null,
      };
    }
    case 'schedule': {
      // Re-validated on the way out: jsonb strips the type, and a malformed
      // row is dropped rather than thrown on.
      const recurrence = config.recurrence;
      const timezone = config.timezone;
      if (typeof timezone !== 'string' || !isRecurrence(recurrence)) {
        return null;
      }
      return { draft: { kind: 'schedule', recurrence, timezone }, keyHint: null };
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
  created_at: Date;
  updated_at: Date;
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
  const row = await db
    .selectFrom('agents')
    .select(AGENT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', agentId)
    .executeTakeFirst();
  return row ? toStored(db, tenantId, row) : null;
}

/** Draft → the row columns the trigger kind needs. */
function rowFieldsOf(
  draft: TriggerDraft,
  existing?: { keyHash?: string; keyHint?: string }
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
        config: JSON.stringify({ match: draft.match ?? {} }),
        next_run_at: null,
        mintedKey: null,
      };
    }
    case 'schedule':
      return {
        event_source: null,
        event_type: null,
        config: JSON.stringify({ recurrence: draft.recurrence, timezone: draft.timezone }),
        next_run_at: computeNextRun(draft.recurrence, draft.timezone, new Date()),
        mintedKey: null,
      };
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
 */
async function reconcileTriggers(
  db: Kysely<DB>,
  tenantId: string,
  agentId: string,
  payloads: TriggerPayload[]
): Promise<MintedApiKey[]> {
  const existingRows = await db
    .selectFrom('agent_triggers')
    .select(['id', 'kind', 'config'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .execute();
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const keptIds = new Set<string>();
  const minted: MintedApiKey[] = [];

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
    const fields = rowFieldsOf(payload.draft, {
      keyHash: typeof existingConfig.keyHash === 'string' ? existingConfig.keyHash : undefined,
      keyHint: typeof existingConfig.keyHint === 'string' ? existingConfig.keyHint : undefined,
    });

    if (match) {
      keptIds.add(match.id);
      await db
        .updateTable('agent_triggers')
        .set({
          event_source: fields.event_source,
          event_type: fields.event_type,
          config: fields.config,
          enabled: payload.enabled,
          next_run_at: fields.next_run_at,
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
  input: SaveAgentInput
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
        description_status: 'stale',
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
  outcome: { status: 'ok'; description: string; reviewNotes: string[] } | { status: 'failed' }
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
