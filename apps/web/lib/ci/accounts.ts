/**
 * The service accounts Renkei reads each host's CI with — runners today,
 * deployment environments and pipeline runs as the CI pages grow — kept
 * as connector configs with their secrets sealed (@renkei/connector-config):
 *
 * - Bitbucket (`ci-bitbucket`): a workspace, and a token that can read
 *   its runners — a workspace access token (Bearer), or a bot account's
 *   email and API token (Basic);
 * - GitHub (`ci-github`): an organization, and a GitHub App installed on
 *   it with read access to its self-hosted runners: the App's ID and its
 *   private key.
 *
 * Secrets are write-only: the page sees whether one is stored, a blank
 * field on save keeps it, and they never leave this module except into
 * the requests that use them (runners.ts).
 */

import { loadKeyring } from '@renkei/crypto';
import {
  getConnectorConfig,
  invalidateConnectorConfigCache,
  setConnectorConfig,
} from '@renkei/connector-config';
import { getDataStore } from '@renkei/db';
import { isRecord } from '@renkei/guards';

export const CI_BITBUCKET = 'ci-bitbucket';
export const CI_GITHUB = 'ci-github';

export interface BitbucketAccount {
  workspace: string;
  auth: 'bearer' | 'basic';
  /** The bot account's email, for Basic. */
  email: string;
  token: string;
}

export interface GithubAccount {
  org: string;
  appId: string;
  privateKey: string;
}

export interface AccountsView {
  bitbucket: {
    workspace: string;
    auth: 'bearer' | 'basic';
    email: string;
    hasToken: boolean;
  } | null;
  github: { org: string; appId: string; hasKey: boolean } | null;
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

function keyring(): Read<Buffer> {
  const loaded = loadKeyring('TOKEN_ENCRYPTION_KEY');
  return loaded.ok
    ? { ok: true, value: loaded.val }
    : { ok: false, error: 'The server cannot open stored secrets right now.' };
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export async function readAccounts(): Promise<
  Read<{ bitbucket: BitbucketAccount | null; github: GithubAccount | null }>
> {
  const key = keyring();
  if (!key.ok) return key;
  const [bitbucket, github] = await Promise.all([
    getConnectorConfig(CI_BITBUCKET, key.value),
    getConnectorConfig(CI_GITHUB, key.value),
  ]);
  if (!bitbucket.ok || !github.ok)
    return { ok: false, error: 'The service accounts could not be read.' };
  const bb = bitbucket.val;
  const gh = github.val;
  return {
    ok: true,
    value: {
      bitbucket:
        bb && text(bb.settings.workspace)
          ? {
              workspace: text(bb.settings.workspace),
              auth: bb.settings.auth === 'basic' ? 'basic' : 'bearer',
              email: text(bb.settings.email),
              token: bb.secrets.token ?? '',
            }
          : null,
      github:
        gh && text(gh.settings.org)
          ? {
              org: text(gh.settings.org),
              appId: text(gh.settings.appId),
              privateKey: gh.secrets.privateKey ?? '',
            }
          : null,
    },
  };
}

/** What the page shows of the accounts: everything but the secrets, which it sees only as stored or not. */
export async function accountsView(): Promise<Read<AccountsView>> {
  const accounts = await readAccounts();
  if (!accounts.ok) return accounts;
  const { bitbucket, github } = accounts.value;
  return {
    ok: true,
    value: {
      bitbucket: bitbucket
        ? {
            workspace: bitbucket.workspace,
            auth: bitbucket.auth,
            email: bitbucket.email,
            hasToken: Boolean(bitbucket.token),
          }
        : null,
      github: github
        ? { org: github.org, appId: github.appId, hasKey: Boolean(github.privateKey) }
        : null,
    },
  };
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Save the Bitbucket account; a blank token keeps the stored one. */
export async function saveBitbucketAccount(body: unknown): Promise<Read<true>> {
  if (!isRecord(body)) return { ok: false, error: 'Send the account as JSON.' };
  const workspace = text(body.workspace).trim();
  const auth = body.auth === 'basic' ? 'basic' : 'bearer';
  const email = text(body.email).trim();
  if (!SLUG.test(workspace))
    return { ok: false, error: 'The workspace is its slug, as in bitbucket.org/<workspace>.' };
  if (auth === 'basic' && !/^[^@\s]+@[^@\s]+$/.test(email))
    return { ok: false, error: 'A bot account signs in with its email.' };
  const current = await readAccounts();
  if (!current.ok) return current;
  const token = text(body.token).trim() || current.value.bitbucket?.token || '';
  if (!token) return { ok: false, error: 'Paste the token.' };
  return write(CI_BITBUCKET, { workspace, auth, email: auth === 'basic' ? email : '' }, { token });
}

/** Save the GitHub account; a blank private key keeps the stored one. */
export async function saveGithubAccount(body: unknown): Promise<Read<true>> {
  if (!isRecord(body)) return { ok: false, error: 'Send the account as JSON.' };
  const org = text(body.org).trim();
  const appId = text(body.appId).trim();
  if (!SLUG.test(org))
    return { ok: false, error: 'The organization is its name, as in github.com/<organization>.' };
  if (!/^\d{1,12}$/.test(appId))
    return { ok: false, error: 'The App ID is the number on the App’s settings page.' };
  const current = await readAccounts();
  if (!current.ok) return current;
  const pasted = text(body.privateKey).trim();
  if (
    pasted &&
    !/^-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----$/.test(pasted)
  ) {
    return { ok: false, error: 'Paste the whole private key file, from -----BEGIN to -----END.' };
  }
  const privateKey = pasted || current.value.github?.privateKey || '';
  if (!privateKey) return { ok: false, error: 'Paste the App’s private key.' };
  return write(CI_GITHUB, { org, appId }, { privateKey });
}

async function write(
  connector: string,
  settings: Record<string, unknown>,
  secrets: Record<string, string>
): Promise<Read<true>> {
  const key = keyring();
  if (!key.ok) return key;
  const saved = await setConnectorConfig(
    connector,
    { enabled: true, settings, secrets },
    key.value
  );
  invalidateConnectorConfigCache(connector);
  return saved.ok ? { ok: true, value: true } : { ok: false, error: 'The account was not saved.' };
}

/** Forget a host's account: its row is kept, emptied, and switched off. */
export async function removeAccount(host: 'bitbucket' | 'github'): Promise<Read<true>> {
  const connector = host === 'bitbucket' ? CI_BITBUCKET : CI_GITHUB;
  const existing = await getDataStore().connectorConfigs.get(connector);
  if (!existing) return { ok: true, value: true };
  const key = keyring();
  if (!key.ok) return key;
  const saved = await setConnectorConfig(
    connector,
    { enabled: false, settings: {}, secrets: {} },
    key.value
  );
  invalidateConnectorConfigCache(connector);
  return saved.ok
    ? { ok: true, value: true }
    : { ok: false, error: 'The account was not removed.' };
}
