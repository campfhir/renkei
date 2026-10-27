/**
 * The server-side fetches both builder pages (new and edit) share: the
 * caller's tool projection (the SAME list the MCP route serves — no new
 * endpoint, the usage-page pattern), their other agents for chained
 * triggers, and the org's enabled model roster for the per-agent override.
 *
 * The model roster and the holiday calendars belong to other areas (chat
 * models, schedule calendars) and are read through their own loaders;
 * without a database those read as empty rather than failing the page.
 */

import { getDatabase } from '@renkei/db';
import type { BlackoutEntry } from '@renkei/agents';
import { DEFAULT_ORG_SETTINGS } from '@renkei/settings';
import { getOrgSettings } from '@renkei/settings';
import { listAvailableTools, type ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { listAgents } from '@/lib/agents/store';
import { listChatModels } from '@/lib/chat/models';
import { loadCalendarOptions } from '@/lib/schedule-calendars';

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
  subject: string,
  excludeAgentId?: string
): Promise<BuilderData> {
  const db = getDatabase();
  const [tools, agents, modelRows, settings, calendars] = await Promise.all([
    listAvailableTools(subject),
    listAgents(subject),
    // An agent runs on a chat model; an image generation model cannot answer.
    db.ok ? listChatModels(db.val) : Promise.resolve([]),
    getOrgSettings(),
    loadCalendarOptions().catch(() => []),
  ]);
  const org = settings.ok ? settings.val : DEFAULT_ORG_SETTINGS;
  return {
    tools,
    otherAgents: agents
      .filter((agent) => agent.id !== excludeAgentId)
      .map((agent) => ({ id: agent.id, name: agent.name })),
    // The picker lists models by label (the chat roster puts the default first).
    models: [...modelRows]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((model) => ({ id: model.id, label: model.label, isDefault: model.isDefault })),
    runLimits: { minutes: org.agentRunTimeoutMinutes, toolCalls: org.agentRunToolCallBudget },
    actApprovalPolicy: org.agentActStepsRequireApproval,
    calendars,
  };
}
