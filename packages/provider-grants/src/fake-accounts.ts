/**
 * The fake vendor accounts of the in-memory app's fake OAuth
 * (fake-oauth.ts): pure derivations from a person's subject, with nothing
 * to import but node:crypto, so a browser spec can name the account and
 * the Atlassian site its person connects as (the stand-in Jira keeps each
 * site's state apart) without reaching into the app.
 */

import { createHash } from 'node:crypto';

/**
 * Providers that are one account at the vendor: a person's Jira, JSM,
 * Confluence and Jira Administration grants are one Atlassian account, as
 * their Microsoft 365 and Entra Developer grants are one directory user.
 */
export function familyOf(provider: string): string {
  if (provider === 'atlassian-bitbucket') return provider;
  if (provider.startsWith('atlassian')) return 'atlassian';
  if (provider === 'entra-developer') return 'microsoft';
  if (provider.startsWith('salesforce')) return 'salesforce';
  if (provider.startsWith('onbase')) return 'onbase';
  return provider;
}

const LABELS: Readonly<Record<string, string>> = {
  atlassian: 'Atlassian',
  'atlassian-bitbucket': 'Bitbucket',
  github: 'GitHub',
  microsoft: 'Microsoft',
  'webex-user': 'Webex',
  zoom: 'Zoom',
  salesforce: 'Salesforce',
  onbase: 'OnBase',
};

/** A fake vendor account: stable per (person, provider family). */
export interface FakeAccount {
  /** The vendor's durable account id, in that vendor's shape. */
  id: string;
  displayName: string;
  email: string;
  /** A login or username, for vendors that have one. */
  login: string;
  /** Hex digits the rest is derived from. */
  seed: string;
}

export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A version-4-shaped UUID from hex digits. */
export function uuidOf(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** Fifteen alphanumerics in Salesforce's id shape, with its key prefix. */
export function salesforceId(prefix: string, hex: string): string {
  return `${prefix}${hex.slice(0, 12).toUpperCase()}`;
}

export function fakeAccount(subject: string, provider: string): FakeAccount {
  const family = familyOf(provider);
  const seed = hash(`${family}:${subject}`);
  const short = seed.slice(0, 6);
  const label = LABELS[family] ?? family;
  const login = `fake-${seed.slice(0, 8)}`;
  let id: string;
  switch (family) {
    case 'atlassian':
      id = `712020:${uuidOf(seed)}`;
      break;
    case 'atlassian-bitbucket':
      id = `{${uuidOf(seed)}}`;
      break;
    case 'github':
      id = String((parseInt(seed.slice(0, 8), 16) % 2_000_000_000) + 1);
      break;
    case 'salesforce':
      id = salesforceId('005', seed);
      break;
    case 'zoom':
      id = Buffer.from(seed.slice(0, 16), 'hex').toString('base64url');
      break;
    default:
      id = uuidOf(seed);
  }
  return {
    id,
    displayName: `${label} user ${short}`,
    email: `${login}@example.com`,
    login,
    seed,
  };
}

/**
 * Who a person works for, as far as a vendor's sites go: their email
 * address's domain — people of one organization share its Atlassian site,
 * as they do in Jira — or, when their address is no more than their
 * subject (the memory suite's sign-in gives a person none of their own),
 * the person alone, in a site nobody else works in.
 */
export function fakeOrganization(subject: string, email: string | null | undefined): string {
  const address = (email ?? '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (!address || address === subject.trim().toLowerCase() || at < 0) return subject;
  return address.slice(at + 1);
}

/** The Atlassian site an organization (`fakeOrganization`) works in. */
export function fakeAtlassianSite(organization: string): { cloudId: string; url: string } {
  const seed = hash(`site:${organization}`);
  return {
    cloudId: uuidOf(seed),
    url: `https://site-${seed.slice(0, 8)}.atlassian.net`,
  };
}
