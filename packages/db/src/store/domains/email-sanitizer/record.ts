import type { Selectable } from 'kysely';
import type {
  EmailClassifierRules,
  EmailCleanerScripts,
  EmailExtractionTemplates,
} from '../../../db.types';
import type { ClassifierRuleRecord, CleanerScriptRecord, ExtractionTemplateRecord } from './types';

export function ruleFromRow(row: Selectable<EmailClassifierRules>): ClassifierRuleRecord {
  return {
    id: row.id,
    category: row.category,
    matchType: row.match_type,
    matchValue: row.match_value,
    senderKey: row.sender_key,
    priority: row.priority,
    enabled: row.enabled,
  };
}

export function ruleValues(rule: ClassifierRuleRecord) {
  return {
    category: rule.category,
    match_type: rule.matchType,
    match_value: rule.matchValue,
    sender_key: rule.senderKey,
    priority: rule.priority,
    enabled: rule.enabled,
  };
}

export function templateFromRow(
  row: Selectable<EmailExtractionTemplates>
): ExtractionTemplateRecord {
  return {
    id: row.id,
    senderKey: row.sender_key,
    version: row.version,
    status: row.status,
    spec: row.spec ?? null,
    matchThreshold: row.match_threshold,
  };
}

export function scriptFromRow(row: Selectable<EmailCleanerScripts>): CleanerScriptRecord {
  return {
    id: row.id,
    name: row.name,
    script: row.script,
    compiled: row.compiled,
    enabled: row.enabled,
    appliesTo: row.applies_to ?? [],
    lastError: row.last_error,
  };
}

export function scriptValues(script: Omit<CleanerScriptRecord, 'lastError'>) {
  return {
    name: script.name,
    script: script.script,
    compiled: script.compiled,
    enabled: script.enabled,
    applies_to: [...script.appliesTo],
  };
}

/** `coalesce(settings->>'apiSurface', '')`, as Postgres reads it. */
export function apiSurfaceOf(settings: unknown): string {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return '';
  const value: unknown = Reflect.get(settings, 'apiSurface');
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
