/**
 * DB accessors for `email_classifier_rules` — content-free sender policy,
 * safe for an org-admin route to read and write directly.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ClassifierRule } from '../types';
import { DEFAULT_CLASSIFIER_RULES } from '../registry/seed';

interface RuleRow {
  id: string;
  category: string;
  match_type: string;
  match_value: string;
  sender_key: string | null;
  priority: number;
  enabled: boolean;
}

function isCategory(value: string): value is ClassifierRule['category'] {
  return value === 'human' || value === 'system_notification' || value === 'marketing';
}

function isMatchType(value: string): value is ClassifierRule['matchType'] {
  return value === 'domain' || value === 'sender_email' || value === 'subject_contains';
}

function toRule(row: RuleRow): ClassifierRule {
  return {
    id: row.id,
    // A row's category/match_type only ever come from upsertClassifierRule's own
    // literal-union input, so these fallbacks are unreachable in practice — the
    // guard exists because the DB layer can't prove that at the type level.
    category: isCategory(row.category) ? row.category : 'human',
    matchType: isMatchType(row.match_type) ? row.match_type : 'domain',
    matchValue: row.match_value,
    senderKey: row.sender_key,
    priority: row.priority,
    enabled: row.enabled,
  };
}

export async function listClassifierRules(
  tenantId: string
): Promise<Result<ClassifierRule[], 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const rowsResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('email_classifier_rules')
        .select([
          'id',
          'category',
          'match_type',
          'match_value',
          'sender_key',
          'priority',
          'enabled',
        ])
        .where('tenant_id', '=', tenantId)
        .orderBy('priority', 'asc')
        .execute(),
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
  tenantId: string,
  rule: ClassifierRuleInput
): Promise<Result<string, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const id = rule.id ?? randomUUID();
  const matchValue = rule.matchValue.trim().toLowerCase();
  const result = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('email_classifier_rules')
        .values({
          id,
          tenant_id: tenantId,
          category: rule.category,
          match_type: rule.matchType,
          match_value: matchValue,
          sender_key: rule.senderKey,
          priority: rule.priority,
          enabled: rule.enabled,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            category: rule.category,
            match_type: rule.matchType,
            match_value: matchValue,
            sender_key: rule.senderKey,
            priority: rule.priority,
            enabled: rule.enabled,
            updated_at: new Date().toISOString(),
          })
        )
        .execute(),
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
export async function seedDefaultClassifierRules(
  tenantId: string
): Promise<Result<{ inserted: number }, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const existingResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('email_classifier_rules')
        .select(['match_type', 'match_value'])
        .where('tenant_id', '=', tenantId)
        .execute(),
    'DB_ERROR' as const
  );
  if (!existingResult.ok) return existingResult;
  const taken = new Set(existingResult.val.map((row) => `${row.match_type} ${row.match_value}`));

  const missing = DEFAULT_CLASSIFIER_RULES.filter(
    (rule) => !taken.has(`${rule.matchType} ${rule.matchValue}`)
  );
  if (missing.length === 0) return ok({ inserted: 0 });

  const result = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('email_classifier_rules')
        .values(
          missing.map((rule) => ({
            id: randomUUID(),
            tenant_id: tenantId,
            category: rule.category,
            match_type: rule.matchType,
            match_value: rule.matchValue,
            sender_key: rule.senderKey,
            priority: rule.priority,
            enabled: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }))
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok({ inserted: missing.length });
}

export async function deleteClassifierRule(
  tenantId: string,
  id: string
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const result = await wrapAsync(
    () =>
      dbResult.val
        .deleteFrom('email_classifier_rules')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id)
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok();
}
