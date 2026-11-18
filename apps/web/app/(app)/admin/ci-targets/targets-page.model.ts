/**
 * The Targets page (targets-page.tsx): the two service accounts and their
 * forms, each target with the runners that fit it, the runners in no
 * target, the target form — its problems as the person types, what Save
 * sends — and "make a target from these labels". Tested in
 * targets-page.model.test.ts.
 *
 * The clock is passed in (`now`) wherever a time is told relative to it.
 */

import { splitLabels, targetFromRunner, targetProblems, type Runner } from '@renkei/ci-blocks';

export type HostKey = 'bitbucket' | 'github';

/**
 * How the Bitbucket account signs in: the Bitbucket connector's OAuth
 * consumer, an OAuth consumer of its own (both by client credentials), a
 * workspace access token, or a bot account's API token.
 */
export type BitbucketAuth = 'connector' | 'oauth' | 'bearer' | 'basic';
export const BITBUCKET_AUTH_CHOICES: { value: BitbucketAuth; label: string }[] = [
  { value: 'connector', label: 'The Bitbucket connector’s OAuth consumer' },
  { value: 'oauth', label: 'An OAuth consumer’s key and secret' },
  { value: 'bearer', label: 'A workspace access token' },
  { value: 'basic', label: 'A bot account’s API token' },
];

export function bitbucketAuthOf(value: string): BitbucketAuth {
  return BITBUCKET_AUTH_CHOICES.find((choice) => choice.value === value)?.value ?? 'bearer';
}
export const HOST_NAMES: Record<HostKey, string> = { bitbucket: 'Bitbucket', github: 'GitHub' };

/** What GET /api/admin/ci-targets answers. */
export interface TargetsPageData {
  accounts: {
    bitbucket: {
      workspace: string;
      auth: BitbucketAuth;
      email: string;
      clientId: string;
      hasToken: boolean;
    } | null;
    github: { org: string; appId: string; hasKey: boolean } | null;
    /** Whether the Bitbucket connector has an OAuth consumer registered. */
    bitbucketConsumer: boolean;
  };
  hosts: Record<
    HostKey,
    { connected: boolean; readAt: string | null; error: string | null; count: number }
  >;
  targets: {
    id: string;
    name: string;
    description: string | null;
    labels: Record<HostKey, string[]>;
    runners: Record<HostKey, Runner[]>;
    online: number;
    total: number;
  }[];
  loose: Runner[];
}

export interface AccountForm {
  host: HostKey;
  /** Bitbucket: the workspace; GitHub: the organization. */
  account: string;
  auth: BitbucketAuth;
  email: string;
  /** Bitbucket: an OAuth consumer's key, for `oauth`. */
  clientId: string;
  appId: string;
  /** The token, consumer secret or private key; blank keeps the stored one. */
  secret: string;
  /** Whether a secret is stored already, for the way the account signs in now (`storedAuth`). */
  hasSecret: boolean;
  storedAuth: BitbucketAuth | null;
  /** Bitbucket: whether the connector has an OAuth consumer to sign in with. */
  consumer: boolean;
}

export interface TargetForm {
  /** Null for a new target. */
  id: string | null;
  name: string;
  description: string;
  bitbucket: string;
  github: string;
}

type Busy = 'load' | 'sync' | 'account' | 'target' | 'delete';

export interface TargetsPageState {
  data: TargetsPageData | null;
  busy: Busy | null;
  error: string | null;
  notice: string | null;
  /** What the server said stops a save. */
  problems: string[];
  account: AccountForm | null;
  target: TargetForm | null;
}

export type TargetsPageAction =
  | { type: 'sent'; busy: Busy }
  | { type: 'loaded'; data: TargetsPageData; notice?: string }
  | { type: 'failed'; error: string; problems?: string[] }
  | { type: 'openAccount'; host: HostKey }
  | {
      type: 'accountField';
      patch: Partial<Omit<AccountForm, 'host' | 'hasSecret' | 'storedAuth' | 'consumer'>>;
    }
  | { type: 'closeAccount' }
  | { type: 'newTarget' }
  | { type: 'editTarget'; id: string }
  | { type: 'targetFromRunner'; runner: Runner }
  | { type: 'targetField'; patch: Partial<Omit<TargetForm, 'id'>> }
  | { type: 'closeTarget' };

export const initialTargetsPage: TargetsPageState = {
  data: null,
  busy: 'load',
  error: null,
  notice: null,
  problems: [],
  account: null,
  target: null,
};

const EMPTY_TARGET: TargetForm = { id: null, name: '', description: '', bitbucket: '', github: '' };

export function targetsPageReducer(
  state: TargetsPageState,
  action: TargetsPageAction
): TargetsPageState {
  switch (action.type) {
    case 'sent':
      return { ...state, busy: action.busy, error: null, notice: null, problems: [] };
    case 'loaded':
      return {
        ...state,
        data: action.data,
        busy: null,
        // A save closes its form; a plain load leaves an open one alone.
        account: action.notice ? null : state.account,
        target: action.notice ? null : state.target,
        notice: action.notice ?? null,
      };
    case 'failed':
      return { ...state, busy: null, error: action.error, problems: action.problems ?? [] };
    case 'openAccount': {
      const accounts = state.data?.accounts;
      const form: AccountForm =
        action.host === 'bitbucket'
          ? {
              host: 'bitbucket',
              account: accounts?.bitbucket?.workspace ?? '',
              // A new account signs in as an OAuth consumer: the connector's when there is one.
              auth:
                accounts?.bitbucket?.auth ?? (accounts?.bitbucketConsumer ? 'connector' : 'oauth'),
              email: accounts?.bitbucket?.email ?? '',
              clientId: accounts?.bitbucket?.auth === 'oauth' ? accounts.bitbucket.clientId : '',
              appId: '',
              secret: '',
              hasSecret: accounts?.bitbucket?.hasToken ?? false,
              storedAuth: accounts?.bitbucket?.auth ?? null,
              consumer: accounts?.bitbucketConsumer ?? false,
            }
          : {
              host: 'github',
              account: accounts?.github?.org ?? '',
              auth: 'bearer',
              email: '',
              clientId: '',
              appId: accounts?.github?.appId ?? '',
              secret: '',
              hasSecret: accounts?.github?.hasKey ?? false,
              storedAuth: null,
              consumer: false,
            };
      return { ...state, account: form, target: null, error: null, notice: null, problems: [] };
    }
    case 'accountField':
      return state.account ? { ...state, account: { ...state.account, ...action.patch } } : state;
    case 'closeAccount':
      return { ...state, account: null, error: null };
    case 'newTarget':
      return {
        ...state,
        target: EMPTY_TARGET,
        account: null,
        error: null,
        notice: null,
        problems: [],
      };
    case 'editTarget': {
      const target = state.data?.targets.find((t) => t.id === action.id);
      if (!target) return state;
      return {
        ...state,
        account: null,
        error: null,
        notice: null,
        problems: [],
        target: {
          id: target.id,
          name: target.name,
          description: target.description ?? '',
          bitbucket: target.labels.bitbucket.join(', '),
          github: target.labels.github.join(', '),
        },
      };
    }
    case 'targetFromRunner': {
      const made = targetFromRunner(action.runner);
      return {
        ...state,
        account: null,
        error: null,
        notice: null,
        problems: [],
        target: {
          id: null,
          name: made.name,
          description: '',
          bitbucket: made.labels.bitbucket.join(', '),
          github: made.labels.github.join(', '),
        },
      };
    }
    case 'targetField':
      return state.target
        ? { ...state, target: { ...state.target, ...action.patch }, problems: [] }
        : state;
    case 'closeTarget':
      return { ...state, target: null, error: null, problems: [] };
  }
}

// ——— what the page derives ———

/** "4 minutes ago", from the clock the component passes. */
export function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

export interface AccountCard {
  host: HostKey;
  title: string;
  state: 'connected' | 'failing' | 'none';
  /** How the account signs in. */
  how: string;
  /** What was read, and when; or what went wrong. */
  status: string;
}

export function accountCards(data: TargetsPageData, now: number): AccountCard[] {
  const { bitbucket, github } = data.accounts;
  const status = (host: HostKey): Pick<AccountCard, 'state' | 'status'> => {
    const read = data.hosts[host];
    if (!read.connected)
      return { state: 'none', status: 'Not connected: runners from this host are not listed.' };
    if (read.error) return { state: 'failing', status: read.error };
    return {
      state: 'connected',
      status: `${read.count} runner${read.count === 1 ? '' : 's'} · read ${read.readAt ? ago(read.readAt, now) : 'just now'}`,
    };
  };
  return [
    {
      host: 'bitbucket',
      title: bitbucket ? `Bitbucket workspace ${bitbucket.workspace}` : 'Bitbucket',
      how: bitbucket
        ? {
            connector: 'The Bitbucket connector’s OAuth consumer, by client credentials.',
            oauth: `OAuth consumer ${bitbucket.clientId}, by client credentials.`,
            bearer: 'Workspace access token.',
            basic: `Bot account ${bitbucket.email}, with an API token.`,
          }[bitbucket.auth]
        : 'An OAuth consumer with Runners: Read, by client credentials — or a workspace access token, or a bot account’s API token.',
      ...status('bitbucket'),
    },
    {
      host: 'github',
      title: github ? `GitHub organization ${github.org}` : 'GitHub',
      how: github
        ? `GitHub App ${github.appId}.`
        : 'A GitHub App installed on the organization, with read access to its self-hosted runners.',
      ...status('github'),
    },
  ];
}

/** Whether the form must be given a secret: none is stored for the way it signs in now. */
export function needsSecret(form: AccountForm): boolean {
  if (form.host === 'bitbucket' && form.auth === 'connector') return false;
  const stored = form.hasSecret && (form.host === 'github' || form.storedAuth === form.auth);
  return !stored;
}

/** What stops the account form from saving. */
export function accountProblems(form: AccountForm): string[] {
  const problems: string[] = [];
  if (!form.account.trim()) {
    problems.push(form.host === 'bitbucket' ? 'Name the workspace.' : 'Name the organization.');
  }
  if (form.host === 'bitbucket') {
    if (form.auth === 'connector' && !form.consumer) {
      problems.push(
        'The Bitbucket connector has no OAuth consumer registered yet: register it under Connectors, or give a key and secret here.'
      );
    }
    if (form.auth === 'oauth' && !form.clientId.trim()) problems.push('Paste the consumer’s key.');
    if (form.auth === 'basic' && !/^[^@\s]+@[^@\s]+$/.test(form.email.trim())) {
      problems.push('A bot account signs in with its email.');
    }
  }
  if (form.host === 'github' && !/^\d{1,12}$/.test(form.appId.trim())) {
    problems.push('The App ID is the number on the App’s settings page.');
  }
  if (needsSecret(form) && !form.secret.trim()) {
    problems.push(
      form.host === 'github'
        ? 'Paste the App’s private key.'
        : form.auth === 'oauth'
          ? 'Paste the consumer’s secret.'
          : 'Paste the token.'
    );
  }
  return problems;
}

export function accountRequest(form: AccountForm): { url: string; body: Record<string, string> } {
  return form.host === 'bitbucket'
    ? {
        url: '/api/admin/ci-accounts/bitbucket',
        body: {
          workspace: form.account.trim(),
          auth: form.auth,
          ...(form.auth === 'basic' ? { email: form.email.trim() } : {}),
          ...(form.auth === 'oauth' ? { clientId: form.clientId.trim() } : {}),
          // The connector's consumer is read from its registration: nothing to send.
          ...(form.auth === 'connector' ? {} : { token: form.secret.trim() }),
        },
      }
    : {
        url: '/api/admin/ci-accounts/github',
        body: {
          org: form.account.trim(),
          appId: form.appId.trim(),
          privateKey: form.secret.trim(),
        },
      };
}

/** What stops the target form from saving, as typed. */
export function targetFormProblems(form: TargetForm): string[] {
  return targetProblems({
    name: form.name.trim(),
    labels: { bitbucket: splitLabels(form.bitbucket), github: splitLabels(form.github) },
  });
}

export function targetRequest(form: TargetForm): {
  url: string;
  method: 'POST' | 'PUT';
  body: { name: string; description: string | null; labels: Record<HostKey, string[]> };
} {
  return {
    url: form.id ? `/api/admin/ci-targets/${form.id}` : '/api/admin/ci-targets',
    method: form.id ? 'PUT' : 'POST',
    body: {
      name: form.name.trim(),
      description: form.description.trim() || null,
      labels: { bitbucket: splitLabels(form.bitbucket), github: splitLabels(form.github) },
    },
  };
}

/** The labels any runner of a host carries, for the form's suggestions. */
export function knownLabels(data: TargetsPageData | null, host: HostKey): string[] {
  const all = [...(data?.loose ?? []), ...(data?.targets.flatMap((t) => t.runners[host]) ?? [])]
    .filter((runner) => runner.host === host)
    .flatMap((runner) => runner.labels);
  return [...new Set(all.map((label) => label.toLowerCase()))].sort();
}

export interface TargetCard {
  id: string;
  name: string;
  description: string | null;
  health: string;
  tone: 'good' | 'warn' | 'bad' | 'none';
  hosts: { host: HostKey; name: string; labels: string[]; runners: string }[];
}

function runnerLine(runners: Runner[]): string {
  if (runners.length === 0) return 'No runner carries these labels.';
  return runners
    .map((r) => `${r.name} ${r.status === 'online' ? (r.busy ? 'busy' : 'online') : r.status}`)
    .join(' · ');
}

export function targetCards(data: TargetsPageData): TargetCard[] {
  return data.targets.map((target) => ({
    id: target.id,
    name: target.name,
    description: target.description,
    health:
      target.total === 0
        ? 'No runners found'
        : target.online === target.total
          ? `All ${target.total} online`
          : `${target.online} of ${target.total} online`,
    tone:
      target.total === 0
        ? 'none'
        : target.online === target.total
          ? 'good'
          : target.online === 0
            ? 'bad'
            : 'warn',
    hosts: (['bitbucket', 'github'] as const)
      .filter((host) => target.labels[host].length > 0)
      .map((host) => ({
        host,
        name: HOST_NAMES[host],
        labels: target.labels[host],
        runners: data.hosts[host].connected
          ? runnerLine(target.runners[host])
          : `${HOST_NAMES[host]} is not connected, so its runners are not listed.`,
      })),
  }));
}

export interface LooseRow {
  key: string;
  runner: Runner;
  host: string;
  status: string;
}

export function looseRows(data: TargetsPageData): LooseRow[] {
  return data.loose.map((runner) => ({
    key: `${runner.host}:${runner.id}`,
    runner,
    host: HOST_NAMES[runner.host],
    status: runner.status === 'online' ? (runner.busy ? 'busy' : 'online') : runner.status,
  }));
}
