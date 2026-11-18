/**
 * CI targets for the Targets page (the ciTargets store domain;
 * @renkei/ci-blocks says what a target is and which runners fit it):
 * each target with the runners each host reports for its labels, the
 * runners in no target, and what each host's service account could read.
 */

import { getDataStore, type CiTargetRecord } from '@renkei/db';
import {
  runnersInNoTarget,
  splitLabels,
  targetHealth,
  targetProblems,
  type Runner,
  type Target,
  type TargetLabels,
} from '@renkei/ci-blocks';
import { isRecord } from '@renkei/guards';
import { accountsView, readAccounts, type AccountsView } from './accounts';
import { readBitbucketRunners, readGithubRunners, type RunnersRead } from './runners';

export interface TargetView extends Target {
  /** Runners that fit, per host, as last read. */
  runners: { bitbucket: Runner[]; github: Runner[] };
  online: number;
  total: number;
}

export interface HostRead {
  /** No service account for this host. */
  connected: boolean;
  /** When the runners were read, when they could be. */
  readAt: string | null;
  error: string | null;
  count: number;
}

export interface TargetsPage {
  accounts: AccountsView;
  hosts: { bitbucket: HostRead; github: HostRead };
  targets: TargetView[];
  /** Runners no target takes. */
  loose: Runner[];
}

const targets = () => getDataStore().ciTargets;

function labelsOf(value: unknown): TargetLabels {
  const entry = isRecord(value) ? value : {};
  const list = (raw: unknown) =>
    Array.isArray(raw) ? raw.filter((l): l is string => typeof l === 'string') : [];
  return { bitbucket: list(entry.bitbucket), github: list(entry.github) };
}

function targetOf(record: CiTargetRecord): Target {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    labels: labelsOf(record.labels),
  };
}

export async function listTargets(): Promise<Target[]> {
  return (await targets().list()).map(targetOf);
}

function hostRead(connected: boolean, read: RunnersRead | null): HostRead {
  if (!connected || !read) return { connected, readAt: null, error: null, count: 0 };
  return read.ok
    ? { connected, readAt: read.readAt, error: null, count: read.runners.length }
    : { connected, readAt: null, error: read.error, count: 0 };
}

/** Everything the Targets page shows; `fresh` reads the runners again rather than from the minute's cache. */
export async function targetsPage(
  options: { fresh?: boolean } = {}
): Promise<TargetsPage | { error: string }> {
  const [accounts, view, list] = await Promise.all([readAccounts(), accountsView(), listTargets()]);
  if (!accounts.ok) return { error: accounts.error };
  if (!view.ok) return { error: view.error };
  const { bitbucket, github } = accounts.value;
  const [bitbucketRead, githubRead] = await Promise.all([
    bitbucket?.token ? readBitbucketRunners(bitbucket, options) : Promise.resolve(null),
    github?.privateKey ? readGithubRunners(github, options) : Promise.resolve(null),
  ]);
  const runners = [
    ...(bitbucketRead?.ok ? bitbucketRead.runners : []),
    ...(githubRead?.ok ? githubRead.runners : []),
  ];
  return {
    accounts: view.value,
    hosts: {
      bitbucket: hostRead(Boolean(bitbucket?.token), bitbucketRead),
      github: hostRead(Boolean(github?.privateKey), githubRead),
    },
    targets: list.map((target) => {
      const health = targetHealth(target, runners);
      return { ...target, runners: health.byHost, online: health.online, total: health.total };
    }),
    loose: runnersInNoTarget(list, runners),
  };
}

export interface TargetPayload {
  name: string;
  description: string | null;
  labels: TargetLabels;
}

/** A create or save body, checked: the problems named, or the target to store. */
export function parseTargetPayload(
  body: unknown
): TargetPayload | { error: string; problems: string[] } {
  if (!isRecord(body)) return { error: 'Send the target as JSON.', problems: [] };
  const labels = isRecord(body.labels) ? body.labels : {};
  const asList = (raw: unknown) =>
    typeof raw === 'string'
      ? splitLabels(raw)
      : Array.isArray(raw)
        ? splitLabels(raw.filter((l) => typeof l === 'string').join(' '))
        : [];
  const target = {
    name: typeof body.name === 'string' ? body.name.trim() : '',
    description:
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim().slice(0, 500)
        : null,
    labels: { bitbucket: asList(labels.bitbucket), github: asList(labels.github) },
  };
  const problems = targetProblems(target);
  return problems.length > 0 ? { error: 'The target cannot be saved yet.', problems } : target;
}

const isTaken = (error: unknown) => isRecord(error) && error.code === '23505';

export async function createTarget(
  input: TargetPayload,
  subject: string
): Promise<{ ok: true; id: string } | { ok: false; error: 'taken' }> {
  try {
    return {
      ok: true,
      id: await targets().create({ ...input, kind: 'runners', createdBy: subject }),
    };
  } catch (error) {
    if (isTaken(error)) return { ok: false, error: 'taken' };
    throw error;
  }
}

export async function updateTarget(
  id: string,
  input: TargetPayload
): Promise<{ ok: true } | { ok: false; error: 'taken' | 'not-found' }> {
  try {
    return (await targets().update(id, { ...input, kind: 'runners' }))
      ? { ok: true }
      : { ok: false, error: 'not-found' };
  } catch (error) {
    if (isTaken(error)) return { ok: false, error: 'taken' };
    throw error;
  }
}

export async function deleteTarget(id: string): Promise<{ name: string } | null> {
  const record = await targets().get(id);
  if (!record) return null;
  return (await targets().delete(id)) ? { name: record.name } : null;
}
