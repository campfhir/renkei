/**
 * `email_classifier_rules`, through the data store
 * (`getDataStore().emailSanitizer`) — content-free sender policy, safe for
 * an org-admin route to read and write directly.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore, type ClassifierRuleRecord } from '@renkei/db';
import { ok, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ClassifierRule } from '../types';
import { DEFAULT_CLASSIFIER_RULES } from '../registry/seed';

function isCategory(value: string): value is ClassifierRule['category'] {
  return value === 'human' || value === 'system_notification' || value === 'marketing';
}

function isMatchType(value: string): value is ClassifierRule['matchType'] {
  return value === 'domain' || value === 'sender_email' || value === 'subject_contains';
}

function toRule(row: ClassifierRuleRecord): ClassifierRule {
  return {
    id: row.id,
    // A row's category/match_type only ever come from upsertClassifierRule's own
    // literal-union input, so these fallbacks are unreachable in practice — the
    // guard exists because the DB layer can't prove that at the type level.
    category: isCategory(row.category) ? row.category : 'human',
    matchType: isMatchType(row.matchType) ? row.matchType : 'domain',
    matchValue: row.matchValue,
    senderKey: row.senderKey,
    priority: row.priority,
    enabled: row.enabled,
  };
}

export async function listClassifierRules(): Promise<Result<ClassifierRule[], 'DB_ERROR'>> {
  const rowsResult = await wrapAsync(
    () => getDataStore().emailSanitizer.listRules(),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;
  return ok(rowsResult.val.map(toRule));
}

export interface ClassifierRuleInput {
  id?: string;
  category: ClassifierRule['category'];
  matchType: ClassifierRule['matchType'];
  matchValue: string;
  senderKey: string | null;
  priority: number;
  enabled: boolean;
}

export async function upsertClassifierRule(
  rule: ClassifierRuleInput
): Promise<Result<string, 'DB_ERROR'>> {
  const id = rule.id ?? randomUUID();
  const result = await wrapAsync(
    () =>
      getDataStore().emailSanitizer.upsertRule({
        id,
        category: rule.category,
        matchType: rule.matchType,
        matchValue: rule.matchValue.trim().toLowerCase(),
        senderKey: rule.senderKey,
        priority: rule.priority,
        enabled: rule.enabled,
      }),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok(id);
}

/**
 * Give a brand-new tenant the shipped starting rules.
 *
 * Called at tenant creation; migration 029 does the same for tenants that
 * already existed. Both are needed — a migration cannot reach a tenant
 * created after it ran. Idempotent by (matchType, matchValue), so calling
 * it twice is harmless and an admin's edit to a seeded rule is never
 * clobbered.
 */
export async function seedDefaultClassifierRules(): Promise<
  Result<{ inserted: number }, 'DB_ERROR'>
> {
  const existingResult = await wrapAsync(
    () => getDataStore().emailSanitizer.listRules(),
    'DB_ERROR' as const
  );
  if (!existingResult.ok) return existingResult;
  const taken = new Set(existingResult.val.map((row) => `${row.matchType} ${row.matchValue}`));

  const missing = DEFAULT_CLASSIFIER_RULES.filter(
    (rule) => !taken.has(`${rule.matchType} ${rule.matchValue}`)
  );
  if (missing.length === 0) return ok({ inserted: 0 });

  const result = await wrapAsync(
    () =>
      getDataStore().emailSanitizer.insertRules(
        missing.map((rule) => ({
          id: randomUUID(),
          category: rule.category,
          matchType: rule.matchType,
          matchValue: rule.matchValue,
          senderKey: rule.senderKey,
          priority: rule.priority,
          enabled: true,
        }))
      ),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok({ inserted: missing.length });
}

export async function deleteClassifierRule(id: string): Promise<Result<void, 'DB_ERROR'>> {
  const result = await wrapAsync(
    () => getDataStore().emailSanitizer.deleteRule(id),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok();
}
