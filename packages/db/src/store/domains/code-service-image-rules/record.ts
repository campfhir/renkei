import type { Selectable } from 'kysely';
import type { CodeServiceImageRules } from '../../../db.types';
import type {
  CodeServiceImageRuleMatch,
  CodeServiceImageRuleRecord,
  CodeServiceImageRuleStore,
} from './types';

export function imageRuleFromRow(
  row: Selectable<CodeServiceImageRules>
): CodeServiceImageRuleRecord {
  return {
    id: row.id,
    pattern: row.pattern,
    note: row.note,
    registryUsername: row.registry_username,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function imageRuleMatchFromRow(
  row: Selectable<CodeServiceImageRules>
): CodeServiceImageRuleMatch {
  return {
    id: row.id,
    pattern: row.pattern,
    registryUsername: row.registry_username,
    registrySealed: row.registry_sealed,
  };
}

export function imageRuleValues(rule: Parameters<CodeServiceImageRuleStore['insert']>[0]) {
  return {
    ...(rule.id !== undefined ? { id: rule.id } : {}),
    pattern: rule.pattern,
    note: rule.note,
    registry_username: rule.registryUsername,
    registry_sealed: rule.registrySealed,
  };
}

export function imageRulePatch(rule: Parameters<CodeServiceImageRuleStore['update']>[0]) {
  return {
    pattern: rule.pattern,
    note: rule.note,
    updated_at: rule.updatedAt,
    ...(rule.credential === undefined
      ? {}
      : rule.credential === null
        ? { registry_username: null, registry_sealed: null }
        : {
            registry_username: rule.credential.registryUsername,
            registry_sealed: rule.credential.registrySealed,
          }),
  };
}
