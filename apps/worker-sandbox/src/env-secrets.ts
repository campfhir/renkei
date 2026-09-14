/**
 * How a workspace environment secret is sealed, and where its key lives.
 *
 * The rule the feature rests on: a value the person typed reaches the
 * environment of their commands and nowhere else — never a tool result,
 * never a prompt, never a log. Two things enforce it here:
 *
 *  - The key. Values are sealed under SANDBOX_ENV_SECRETS_KEY, a key
 *    THIS worker holds and the web app does not have to, so a value goes
 *    through the web app exactly once (the UI's POST) and only this
 *    process can ever open it again. Falling back to TOKEN_ENCRYPTION_KEY
 *    keeps a one-key deployment working; a dedicated key is what
 *    DEPLOYMENT.md recommends. Neither set means the feature is closed —
 *    the set/list/delete verbs answer 503 and nothing is stored in the
 *    clear.
 *  - The scrub. Every text this worker returns for a workspace — a
 *    command's output, a file's contents, a grep match, a diff — passes
 *    through `scrubSecretValues` with the caller's current values, so a
 *    command that prints its environment, or writes a token into a file
 *    a later read picks up, still answers with the mask. What a process
 *    does with a value it was given (sends it to the service it is for)
 *    is, of course, the point.
 *
 * The envelope is @renkei/crypto's secretbox with an `env1.` prefix, so
 * a row can never be mistaken for a grant token or a browser secret and
 * opened with the wrong key.
 */

import { decrypt, encrypt, parseEncryptionKey } from '@renkei/crypto';
import { scrubSecretValues } from '@renkei/connector-sandbox';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { listSealedEnv, touchEnvSecretsUsed, type EnvTarget } from './env-secrets-store';

const PREFIX = 'env1.';

let cachedKey: Buffer | null | undefined;

/** The sealing key, resolved once: SANDBOX_ENV_SECRETS_KEY, else TOKEN_ENCRYPTION_KEY, else none. */
export function envSecretsKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = (
    process.env.SANDBOX_ENV_SECRETS_KEY ??
    process.env.TOKEN_ENCRYPTION_KEY ??
    ''
  ).trim();
  const parsed = raw ? parseEncryptionKey(raw) : null;
  cachedKey = parsed && parsed.ok ? parsed.val : null;
  return cachedKey;
}

/** Test-only: forget the resolved key so a test can set the environment. */
export function resetEnvSecretsKeyForTests(): void {
  cachedKey = undefined;
}

export function envSecretsEnabled(): boolean {
  return envSecretsKey() !== null;
}

export function sealEnvValue(value: string, key: Buffer): string {
  return `${PREFIX}${encrypt(value, key)}`;
}

export function openEnvValue(sealed: string, key: Buffer): string | null {
  if (!sealed.startsWith(PREFIX)) return null;
  const opened = decrypt(sealed.slice(PREFIX.length), key);
  return opened.ok ? opened.val : null;
}

/** A caller's variables, opened — for a command's environment and for the scrub. */
export interface OpenedEnv {
  values: Record<string, string>;
  /** Names whose sealed value did not open (a rotated key); reported, never silently dropped. */
  unreadable: string[];
  /** The rows that opened, for `markEnvUsed`. */
  usedIds: string[];
}

export const EMPTY_ENV: OpenedEnv = { values: {}, unreadable: [], usedIds: [] };

export async function openCallerEnv(db: Kysely<DB>, target: EnvTarget): Promise<OpenedEnv> {
  const key = envSecretsKey();
  const rows = key ? await listSealedEnv(db, target) : [];
  const values: Record<string, string> = {};
  const unreadable: string[] = [];
  const usedIds: string[] = [];
  for (const row of rows) {
    const value = key ? openEnvValue(row.sealed, key) : null;
    if (value === null) {
      unreadable.push(row.name);
      continue;
    }
    values[row.name] = value;
    usedIds.push(row.id);
  }
  return { values, unreadable, usedIds };
}

/** Mark the variables a command just ran with as used. */
export async function markEnvUsed(db: Kysely<DB>, opened: OpenedEnv): Promise<void> {
  await touchEnvSecretsUsed(db, opened.usedIds);
}

/** The mask applied to everything a workspace answers: every value, in every spelling the browser scrub knows. */
export function scrubEnv(text: string, opened: OpenedEnv): string {
  return scrubSecretValues(text, Object.values(opened.values));
}
