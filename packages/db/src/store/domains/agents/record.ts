import type { Selectable } from 'kysely';
import type { AgentTriggers, Agents } from '../../../db.types';
import type { AgentDefinitionValues, AgentRecord, AgentTriggerRecord } from './types';

export function triggerFromRow(row: Selectable<AgentTriggers>): AgentTriggerRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    eventSource: row.event_source,
    eventType: row.event_type,
    config: row.config,
    enabled: row.enabled,
    nextRunAt: row.next_run_at,
    lastFiredAt: row.last_fired_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export function agentFromRow(row: Selectable<Agents>, triggers: AgentTriggerRecord[]): AgentRecord {
  return {
    id: row.id,
    ownerSubject: row.owner_subject,
    name: row.name,
    description: row.description,
    descriptionStatus: row.description_status,
    reviewNotes: row.review_notes,
    instructions: row.instructions,
    tools: row.tools,
    stepsVersion: row.steps_version,
    llmModelId: row.llm_model_id,
    enabled: row.enabled,
    guardrails: row.guardrails,
    canAskQuestions: row.can_ask_questions,
    autoAcceptActions: row.auto_accept_actions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    triggers,
  };
}

/** The definition as agents columns (tools as JSON text, as pg wants jsonb). */
export function definitionColumns(values: AgentDefinitionValues) {
  return {
    name: values.name,
    instructions: values.instructions,
    tools: JSON.stringify(values.tools),
    llm_model_id: values.llmModelId,
    enabled: values.enabled,
    guardrails: values.guardrails,
    can_ask_questions: values.canAskQuestions,
    auto_accept_actions: values.autoAcceptActions,
  };
}

/** A refusal on the agents name key — the one uniqueness a save can hit. */
export function isNameTaken(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'agents_name'
  );
}

/** `x LIKE pattern` with the pattern's own wildcards escaped. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
