/**
 * The server-side fetches both builder pages (new and edit) share: the
 * caller's tool projection (the SAME list the MCP route serves — no new
 * endpoint, the usage-page pattern), their other agents for chained
 * triggers, and the org's enabled model roster for the per-agent override.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isBlackoutEntry, MAX_STEP_ATTEMPTS, type BlackoutEntry } from '@renkei/agents';
import { getOrgSettings } from '@renkei/settings';
import { listAvailableTools, type ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { listAgents } from '@/lib/agents/store';

export interface BuilderData {
  tools: ToolDescriptor[];
  otherAgents: { id: string; name: string }[];
  models: { id: string; label: string; isDefault: boolean }[];
  /** The org's per-step attempt ceiling — the builder offers no more. */
  attemptsCap: number;
  /**
   * The org's holiday calendars, DATES INCLUDED: the schedule editor's
   * live next-run preview computes client-side with the same function the
   * server uses, so it needs the real blackout dates, not just names.
   */
  calendars: { id: string; name: string; dates: BlackoutEntry[] }[];
}

export async function loadBuilderData(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  excludeAgentId?: string
): Promise<BuilderData> {
  const [tools, agents, modelRows, settings, calendarRows] = await Promise.all([
    listAvailableTools(tenantId, subject),
    listAgents(db, tenantId, subject),
    db
      .selectFrom('llm_model_configs')
      .select(['id', 'label', 'is_default'])
      .where('tenant_id', '=', tenantId)
      .where('enabled', '=', true)
      .orderBy('label')
      .execute(),
    getOrgSettings(tenantId),
    db
      .selectFrom('schedule_calendars')
      .select(['id', 'name', 'dates'])
      .where('tenant_id', '=', tenantId)
      .orderBy('name')
      .execute(),
  ]);
  return {
    tools,
    otherAgents: agents
      .filter((agent) => agent.id !== excludeAgentId)
      .map((agent) => ({ id: agent.id, name: agent.name })),
    models: modelRows.map((model) => ({
      id: model.id,
      label: model.label,
      isDefault: model.is_default,
    })),
    // The org cap may exceed the 10 default — it is the real ceiling.
    attemptsCap: Math.max(1, settings.ok ? settings.val.agentMaxStepAttempts : MAX_STEP_ATTEMPTS),
    calendars: calendarRows.map((row) => ({
      id: row.id,
      name: row.name,
      dates: Array.isArray(row.dates) ? row.dates.filter(isBlackoutEntry) : [],
    })),
  };
}
