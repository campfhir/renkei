/**
 * Postgres access for an organization's service image allow-list — the
 * `code_service_image_rules` rows (migration 122). A rule's registry
 * credential is sealed here under this worker's own key (the env-secrets
 * arrangement: SANDBOX_ENV_SECRETS_KEY, else TOKEN_ENCRYPTION_KEY), with a
 * `reg1.` prefix so a row can never be mistaken for an environment
 * secret and opened as one. The username is kept in the clear — a
 * listing shows it, so an operator can tell which credential a rule
 * carries; the secret is opened only for a pull, into the one request
 * that presents it.
 */

import { decrypt, encrypt } from '@renkei/crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { DEFAULT_IMAGE_RULES, type ImageRuleSummary } from '@renkei/connector-sandbox';
import { envSecretsKey } from './env-secrets';

const PREFIX = 'reg1.';

export function sealRegistrySecret(value: string, key: Buffer): string {
  return `${PREFIX}${encrypt(value, key)}`;
}

export function openRegistrySecret(sealed: string, key: Buffer): string | null {
  if (!sealed.startsWith(PREFIX)) return null;
  const opened = decrypt(sealed.slice(PREFIX.length), key);
  return opened.ok ? opened.val : null;
}

const SUMMARY_COLUMNS = [
  'id',
  'pattern',
  'note',
  'registry_username',
  'created_at',
  'updated_at',
] as const;

function toSummary(row: {
  id: string;
  pattern: string;
  note: string | null;
  registry_username: string | null;
  created_at: Date;
  updated_at: Date;
}): ImageRuleSummary {
  return {
    id: row.id,
    pattern: row.pattern,
    note: row.note,
    registryUsername: row.registry_username,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listImageRules(
  db: Kysely<DB>,
  tenantId: string
): Promise<ImageRuleSummary[]> {
  const rows = await db
    .selectFrom('code_service_image_rules')
    .select(SUMMARY_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .orderBy('pattern')
    .execute();
  return rows.map(toSummary);
}

export async function countImageRules(db: Kysely<DB>, tenantId: string): Promise<number> {
  const row = await db
    .selectFrom('code_service_image_rules')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  return row?.count ? Number(row.count) : 0;
}

/** Every rule with what a pull needs: the pattern, and the credential's sealed value when there is one. */
export async function listImageRulesForMatching(
  db: Kysely<DB>,
  tenantId: string
): Promise<
  Array<{
    id: string;
    pattern: string;
    registryUsername: string | null;
    registrySealed: string | null;
  }>
> {
  const rows = await db
    .selectFrom('code_service_image_rules')
    .select(['id', 'pattern', 'registry_username', 'registry_sealed'])
    .where('tenant_id', '=', tenantId)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    pattern: row.pattern,
    registryUsername: row.registry_username,
    registrySealed: row.registry_sealed,
  }));
}

export class DuplicateRuleError extends Error {
  constructor() {
    super('A rule for that pattern already exists.');
    this.name = 'DuplicateRuleError';
  }
}

function isDuplicate(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('idx_code_service_image_rules_tenant_pattern')
  );
}

export async function insertImageRule(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    pattern: string;
    note: string | null;
    registryUsername: string | null;
    registrySealed: string | null;
  }
): Promise<ImageRuleSummary> {
  try {
    const row = await db
      .insertInto('code_service_image_rules')
      .values({
        tenant_id: input.tenantId,
        pattern: input.pattern,
        note: input.note,
        registry_username: input.registryUsername,
        registry_sealed: input.registrySealed,
      })
      .returning(SUMMARY_COLUMNS)
      .executeTakeFirstOrThrow();
    return toSummary(row);
  } catch (error) {
    if (isDuplicate(error)) throw new DuplicateRuleError();
    throw error;
  }
}

/**
 * Change a rule: its pattern and note always; its credential only when
 * `credential` is given — a new pair replaces it, null clears it, and
 * undefined leaves what is there.
 */
export async function updateImageRule(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    id: string;
    pattern: string;
    note: string | null;
    credential?: { registryUsername: string; registrySealed: string } | null;
  }
): Promise<ImageRuleSummary | undefined> {
  try {
    const row = await db
      .updateTable('code_service_image_rules')
      .set({
        pattern: input.pattern,
        note: input.note,
        updated_at: new Date(),
        ...(input.credential === undefined
          ? {}
          : input.credential === null
            ? { registry_username: null, registry_sealed: null }
            : {
                registry_username: input.credential.registryUsername,
                registry_sealed: input.credential.registrySealed,
              }),
      })
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.id)
      .returning(SUMMARY_COLUMNS)
      .executeTakeFirst();
    return row ? toSummary(row) : undefined;
  } catch (error) {
    if (isDuplicate(error)) throw new DuplicateRuleError();
    throw error;
  }
}

export async function deleteImageRule(
  db: Kysely<DB>,
  tenantId: string,
  id: string
): Promise<boolean> {
  const result = await db
    .deleteFrom('code_service_image_rules')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}

/** Put the seeded defaults back — the ones missing; rows an operator kept or changed are left alone. */
export async function restoreDefaultImageRules(db: Kysely<DB>, tenantId: string): Promise<number> {
  let added = 0;
  for (const rule of DEFAULT_IMAGE_RULES) {
    const result = await db
      .insertInto('code_service_image_rules')
      .values({ tenant_id: tenantId, pattern: rule.pattern, note: rule.note })
      .onConflict((oc) => oc.columns(['tenant_id', 'pattern']).doNothing())
      .executeTakeFirst();
    added += Number(result.numInsertedOrUpdatedRows ?? 0);
  }
  return added;
}

/** Whether a credential can be sealed here at all — the same key the env secrets need. */
export function registrySecretsKey(): Buffer | null {
  return envSecretsKey();
}
