/**
 * The server-side fetches both builder pages (new and edit) share: the
 * caller's tool projection (the SAME list the MCP route serves — no new
 * endpoint, the usage-page pattern), their other agents for chained
 * triggers, and the org's enabled model roster for the per-agent override.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { chatModelsOnly } from '@renkei/agent-llm';
import { isBlackoutEntry, type BlackoutEntry } from '@renkei/agents';
import { DEFAULT_ORG_SETTINGS } from '@renkei/settings';
import { getOrgSettings } from '@renkei/settings';
import { listAvailableTools, type ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { listAgents } from '@/lib/agents/store';

export interface BuilderData {
  tools: ToolDescriptor[];
  otherAgents: { id: string; name: string }[];
  models: { id: string; label: string; isDefault: boolean }[];
  /**
   * The org's hard limits on every run — shown beside the instructions so
   * an author writes for the budget the agent will actually have.
   */
  runLimits: { minutes: number; toolCalls: number };
  /** The org's policy on when a person must accept staged actions anyway. */
  actApprovalPolicy: 'externally_triggered' | 'all' | 'off';
  /**
   * The org's holiday calendars, DATES INCLUDED: the schedule editor's
   * live next-run preview computes client-side with the same function the
   * server uses, so it needs the real blackout dates, not just names.
   */
  calendars: { id: string; name: string; dates: BlackoutEntry[] }[];
}

export async function loadBuilderData(
  db: Kysely<DB>,
  subject: string,
  excludeAgentId?: string
): Promise<BuilderData> {
  const [tools, agents, modelRows, settings, calendarRows] = await Promise.all([
    listAvailableTools(subject),
    listAgents(db, subject),
    db
      .selectFrom('llm_model_configs')
      .select(['id', 'label', 'is_default'])
      .where('enabled', '=', true)
      // An agent runs on a chat model; an image generation model cannot answer.
      .where(chatModelsOnly)
      .orderBy('label')
      .execute(),
    getOrgSettings(),
    db
      .selectFrom('schedule_calendars')
      .select(['id', 'name', 'dates'])
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
    runLimits: {
      minutes: (settings.ok ? settings.val : DEFAULT_ORG_SETTINGS).agentRunTimeoutMinutes,
      toolCalls: (settings.ok ? settings.val : DEFAULT_ORG_SETTINGS).agentRunToolCallBudget,
    },
    actApprovalPolicy: (settings.ok ? settings.val : DEFAULT_ORG_SETTINGS)
      .agentActStepsRequireApproval,
    calendars: calendarRows.map((row) => ({
      id: row.id,
      name: row.name,
      dates: Array.isArray(row.dates) ? row.dates.filter(isBlackoutEntry) : [],
    })),
  };
}
