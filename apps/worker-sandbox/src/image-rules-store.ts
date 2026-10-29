/**
 * An organization's service image allow-list — the
 * `code_service_image_rules` rows (migration 122), through the data store
 * (`codeServiceImageRules`). A rule's registry credential is sealed here
 * under this worker's own key (the env-secrets arrangement:
 * SANDBOX_ENV_SECRETS_KEY, else TOKEN_ENCRYPTION_KEY), with a `reg1.`
 * prefix so a row can never be mistaken for an environment secret and
 * opened as one. The username is kept in the clear — a listing shows it,
 * so an operator can tell which credential a rule carries; the secret is
 * opened only for a pull, into the one request that presents it.
 */

import { decrypt, encrypt } from '@renkei/crypto';
import { getDataStore } from '@renkei/db';
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

const rules = () => getDataStore().codeServiceImageRules;

export async function listImageRules(): Promise<ImageRuleSummary[]> {
  return rules().list();
}

export async function countImageRules(): Promise<number> {
  return rules().count();
}

/** Every rule with what a pull needs: the pattern, and the credential's sealed value when there is one. */
export async function listImageRulesForMatching(): Promise<
  Array<{
    id: string;
    pattern: string;
    registryUsername: string | null;
    registrySealed: string | null;
  }>
> {
  return rules().listForMatching();
}

export class DuplicateRuleError extends Error {
  constructor() {
    super('A rule for that pattern already exists.');
    this.name = 'DuplicateRuleError';
  }
}

/** A unique violation: the pattern is the table's one unique key besides the generated id. */
function isDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export async function insertImageRule(input: {
  pattern: string;
  note: string | null;
  registryUsername: string | null;
  registrySealed: string | null;
}): Promise<ImageRuleSummary> {
  try {
    return await rules().insert(input);
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
export async function updateImageRule(input: {
  id: string;
  pattern: string;
  note: string | null;
  credential?: { registryUsername: string; registrySealed: string } | null;
}): Promise<ImageRuleSummary | undefined> {
  try {
    return (await rules().update({ ...input, updatedAt: new Date() })) ?? undefined;
  } catch (error) {
    if (isDuplicate(error)) throw new DuplicateRuleError();
    throw error;
  }
}

export async function deleteImageRule(id: string): Promise<boolean> {
  return rules().delete(id);
}

/** Put the seeded defaults back — the ones missing; rows an operator kept or changed are left alone. */
export async function restoreDefaultImageRules(): Promise<number> {
  return rules().insertMissing(
    DEFAULT_IMAGE_RULES.map((rule) => ({ pattern: rule.pattern, note: rule.note }))
  );
}

/** Whether a credential can be sealed here at all — the same key the env secrets need. */
export function registrySecretsKey(): Buffer | null {
  return envSecretsKey();
}
