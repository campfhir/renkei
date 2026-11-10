/**
 * What the identity provider CLI does (cli.ts is the terminal around it):
 * read the organization's OIDC record and change the fields named on the
 * command line, leaving the rest as stored.
 *
 * It exists for the lockout the web app cannot get itself out of: every
 * change to the identity provider in the app needs an operator session,
 * and a session needs a sign-in, so once the provider's client secret has
 * expired (or the client was re-registered) nobody can sign in to replace
 * it. Whoever holds the database URL and the deployment's encryption key
 * can, from here. Those two are the authority: this tool asks for nothing
 * else and is not part of any image.
 *
 * It goes through the data store like every other script, and seals the
 * client secret with TOKEN_ENCRYPTION_KEY exactly as the app does, so the
 * app reads the new value on the next sign-in, with no restart.
 */

import { randomUUID } from 'node:crypto';
import { decrypt, encrypt, type Keyring } from '@renkei/crypto';
import type { DataStore, OidcConfigRecord } from '@renkei/db';

/** The fields a `set` may name. Absent means "leave as stored". */
export interface IdpChange {
  issuer?: string;
  clientId?: string;
  /** The new client secret, in the clear; sealed before it is stored. */
  clientSecret?: string;
  /** null clears a claim field. */
  roleClaim?: string | null;
  operatorIdpValue?: string | null;
  userIdpValue?: string | null;
  groupsClaim?: string | null;
}

export type Command =
  | { kind: 'show' }
  /** `readSecret`: the command line asked for a new client secret, read apart from it. */
  | { kind: 'set'; change: IdpChange; readSecret: boolean }
  | { kind: 'help' };

export const USAGE = `Usage: pnpm --filter @renkei/idp-cli idp <command>

  show                     Print the stored identity provider (never the secret).
  set [options]            Change the fields named; everything else stays as stored.

Options for set:
  --client-secret          Replace the client secret. The value is not taken from
                           the command line: it is read from IDP_CLIENT_SECRET,
                           from standard input when piped, or asked for.
  --client-id <id>         Replace the client id.
  --issuer <https url>     Replace the issuer (the "issuer" of the provider's
                           discovery document, exactly).
  --role-claim <claim>     The id_token claim that carries roles.
  --operator-value <v>     The claim value that makes someone an operator.
  --user-value <v>         The claim value that makes someone a user.
  --groups-claim <claim>   The id_token claim that carries groups.
                           An empty value ("") clears any of these four.

Environment: DATABASE_URL, and TOKEN_ENCRYPTION_KEY (or TOKEN_ENCRYPTION_KEYS)
as the web app has them.`;

const VALUE_FLAGS = {
  '--client-id': 'clientId',
  '--issuer': 'issuer',
  '--role-claim': 'roleClaim',
  '--operator-value': 'operatorIdpValue',
  '--user-value': 'userIdpValue',
  '--groups-claim': 'groupsClaim',
} as const;
type ValueFlag = keyof typeof VALUE_FLAGS;
const CLEARABLE: ReadonlySet<string> = new Set([
  'roleClaim',
  'operatorIdpValue',
  'userIdpValue',
  'groupsClaim',
]);

function isValueFlag(flag: string): flag is ValueFlag {
  return Object.hasOwn(VALUE_FLAGS, flag);
}

/** A problem with what was asked, in words for the terminal. */
export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { kind: 'help' };
  }
  if (command === 'show') {
    if (rest.length > 0) throw new UsageError(`show takes no options (got ${rest[0]}).`);
    return { kind: 'show' };
  }
  if (command !== 'set') throw new UsageError(`Unknown command "${command}".`);

  const change: IdpChange = {};
  let readSecret = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--client-secret') {
      readSecret = true;
      continue;
    }
    if (arg.startsWith('--client-secret=')) {
      throw new UsageError(
        'The client secret is not taken from the command line, where the shell history and the process list keep it. Pass --client-secret alone and enter the value when asked (or set IDP_CLIENT_SECRET, or pipe it in).'
      );
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!isValueFlag(flag)) throw new UsageError(`Unknown option "${arg}".`);
    let value: string | undefined;
    if (eq === -1) {
      i += 1;
      value = rest[i];
    } else {
      value = arg.slice(eq + 1);
    }
    if (value === undefined) throw new UsageError(`${flag} needs a value.`);
    value = value.trim();
    const field = VALUE_FLAGS[flag];
    if (value === '') {
      if (!CLEARABLE.has(field)) throw new UsageError(`${flag} cannot be empty.`);
      Object.assign(change, { [field]: null });
    } else {
      Object.assign(change, { [field]: value });
    }
  }
  if (change.issuer !== undefined) assertIssuer(change.issuer);
  if (!readSecret && Object.keys(change).length === 0) {
    throw new UsageError('set needs at least one option; nothing was changed.');
  }
  return { kind: 'set', change, readSecret };
}

/** Sign-in fetches the issuer's discovery document, and only over public https. */
function assertIssuer(issuer: string): void {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new UsageError(`--issuer "${issuer}" is not a URL.`);
  }
  if (url.protocol !== 'https:') throw new UsageError('--issuer must be an https URL.');
}

/** What `show` prints: the record without its secret, and whether the secret still opens. */
export interface IdpSummary extends Omit<OidcConfigRecord, 'clientSecret'> {
  /** Whether this environment's key opens the stored client secret. */
  clientSecret: 'stored' | 'stored, but this TOKEN_ENCRYPTION_KEY does not open it';
}

export async function showIdp(store: DataStore, keyring: Keyring): Promise<IdpSummary | null> {
  const record = await store.oidcConfig.get();
  if (!record) return null;
  const { clientSecret, ...rest } = record;
  return {
    ...rest,
    clientSecret: decrypt(clientSecret, keyring).ok
      ? 'stored'
      : 'stored, but this TOKEN_ENCRYPTION_KEY does not open it',
  };
}

export type ApplyResult =
  /** The fields that were written, by their option names' fields. */
  | { ok: true; changed: (keyof IdpChange)[]; summary: IdpSummary }
  | { ok: false; reason: 'not-configured' | 'empty-secret' };

/**
 * Write the named fields. The record must exist: creating the first one is
 * first-run setup's job (/setup, with SETUP_SECRET), which also checks the
 * provider answers.
 */
export async function applyChange(
  store: DataStore,
  keyring: Keyring,
  change: IdpChange
): Promise<ApplyResult> {
  if (change.clientSecret !== undefined && change.clientSecret.length === 0) {
    return { ok: false, reason: 'empty-secret' };
  }
  const existing = await store.oidcConfig.get();
  if (!existing) return { ok: false, reason: 'not-configured' };

  const changed: (keyof IdpChange)[] = [];
  for (const key of ['issuer', 'clientId', 'clientSecret'] as const) {
    if (change[key] !== undefined) changed.push(key);
  }
  const claims = {
    roleClaim: existing.roleClaim,
    operatorIdpValue: existing.operatorIdpValue,
    userIdpValue: existing.userIdpValue,
    groupsClaim: existing.groupsClaim,
  };
  let claimsChanged = false;
  for (const key of ['roleClaim', 'operatorIdpValue', 'userIdpValue', 'groupsClaim'] as const) {
    const value = change[key];
    if (value === undefined) continue;
    claims[key] = value;
    claimsChanged = true;
    changed.push(key);
  }

  if (changed.some((key) => key === 'issuer' || key === 'clientId' || key === 'clientSecret')) {
    await store.oidcConfig.save({
      // Only used were the row missing; an existing row keeps its id.
      id: randomUUID(),
      issuer: change.issuer ?? existing.issuer,
      clientId: change.clientId ?? existing.clientId,
      // The stored ciphertext goes back as it is when the secret is not changing.
      clientSecret:
        change.clientSecret !== undefined
          ? encrypt(change.clientSecret, keyring)
          : existing.clientSecret,
      operatorIdpValue: existing.operatorIdpValue,
      userIdpValue: existing.userIdpValue,
      groupsClaim: existing.groupsClaim,
    });
  }
  if (claimsChanged) await store.oidcConfig.updateClaims(claims);

  const summary = await showIdp(store, keyring);
  if (!summary) return { ok: false, reason: 'not-configured' };
  return { ok: true, changed, summary };
}

/** The summary as the lines `show` prints. */
export function summaryLines(summary: IdpSummary): string[] {
  const or = (value: string | null, empty: string) => value ?? `(${empty})`;
  return [
    `issuer:          ${summary.issuer}`,
    `client id:       ${summary.clientId}`,
    `client secret:   ${summary.clientSecret}`,
    `role claim:      ${or(summary.roleClaim, 'none: everyone who signs in is a user')}`,
    `operator value:  ${or(summary.operatorIdpValue, 'none')}`,
    `user value:      ${or(summary.userIdpValue, 'none')}`,
    `groups claim:    ${or(summary.groupsClaim, 'none: nobody is in any group')}`,
  ];
}
