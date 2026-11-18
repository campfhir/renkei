/**
 * Targets: where a block that runs on a target runs. A target is a name
 * and, for each host, the runner labels a pipeline's `runs-on` gets there
 * — `self.hosted, linux, onprem-app` on Bitbucket, `self-hosted, linux,
 * onprem-app` on GitHub. A runner belongs to a target when it carries
 * every one of the target's labels for its host; a runner in no target is
 * listed so an admin can make one from its labels.
 *
 * Runners are read from each host by a service account (the web app's
 * lib/ci/runners.ts); these read the hosts' answers:
 * - GitHub: an organization's self-hosted runners
 *   (`GET /orgs/{org}/actions/runners`), labels as objects;
 * - Bitbucket: a workspace's runners, from the endpoint Atlassian's own
 *   runner autoscaler uses (Bitbucket has no public runner API); labels as
 *   strings, status under `state`.
 */

import { isRecord } from '@renkei/guards';
import type { Host } from './render';

export type RunnerStatus = 'online' | 'offline' | 'unregistered';

export interface Runner {
  host: Host;
  id: string;
  name: string;
  /** As the host reports them; compared without case. */
  labels: string[];
  status: RunnerStatus;
  /** Running a job now (GitHub says; Bitbucket does not). */
  busy: boolean;
}

export interface TargetLabels {
  bitbucket: string[];
  github: string[];
}

export interface Target {
  id: string;
  name: string;
  description: string | null;
  labels: TargetLabels;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/** An organization's runners as GitHub answers `GET /orgs/{org}/actions/runners`. */
export function parseGithubRunners(body: unknown): Runner[] {
  const runners = isRecord(body) && Array.isArray(body.runners) ? body.runners : [];
  return runners.filter(isRecord).map((runner) => ({
    host: 'github',
    id: text(runner.id),
    name: text(runner.name),
    labels: (Array.isArray(runner.labels) ? runner.labels : [])
      .map((label) => (isRecord(label) ? text(label.name) : text(label)))
      .filter(Boolean),
    status: runner.status === 'online' ? 'online' : 'offline',
    busy: runner.busy === true,
  }));
}

/** A workspace's runners as Bitbucket answers its runners endpoint (`values`, paged). */
export function parseBitbucketRunners(body: unknown): Runner[] {
  const values = isRecord(body) && Array.isArray(body.values) ? body.values : [];
  return values.filter(isRecord).map((runner) => {
    const state = isRecord(runner.state) ? text(runner.state.status).toUpperCase() : '';
    return {
      host: 'bitbucket',
      id: text(runner.uuid),
      name: text(runner.name),
      labels: (Array.isArray(runner.labels) ? runner.labels : []).map(text).filter(Boolean),
      status: state === 'ONLINE' ? 'online' : state === 'UNREGISTERED' ? 'unregistered' : 'offline',
      busy: false,
    };
  });
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
/** The label every self-hosted runner carries, which runs-on must include. */
export const SELF_HOSTED_LABEL: Record<Host, string> = {
  bitbucket: 'self.hosted',
  github: 'self-hosted',
};

/** Labels as typed (commas, spaces or lines between), each once, in order. */
export function splitLabels(value: string): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const label of value
    .split(/[\s,]+/)
    .map((l) => l.trim())
    .filter(Boolean)) {
    if (!seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      labels.push(label);
    }
  }
  return labels;
}

/** What is wrong with a target as an admin wrote it; none means it can be saved. */
export function targetProblems(target: { name: string; labels: TargetLabels }): string[] {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9-]{1,49}$/.test(target.name)) {
    problems.push('Name the target in lower case: letters, digits and -, like onprem-app.');
  }
  const hosts: Host[] = ['bitbucket', 'github'];
  if (hosts.every((host) => target.labels[host].length === 0)) {
    problems.push('Give the target runner labels for Bitbucket, GitHub or both.');
  }
  for (const host of hosts) {
    const labels = target.labels[host];
    if (labels.length === 0) continue;
    const hostName = host === 'bitbucket' ? 'Bitbucket' : 'GitHub';
    for (const label of labels) {
      if (!LABEL.test(label))
        problems.push(`“${label}” is not a runner label ${hostName} accepts.`);
    }
    if (!labels.some((l) => l.toLowerCase() === SELF_HOSTED_LABEL[host])) {
      problems.push(
        `${hostName} labels must include ${SELF_HOSTED_LABEL[host]}, or the job goes to a hosted runner.`
      );
    }
    if (labels.length === 1) {
      problems.push(
        `${hostName} labels need more than ${SELF_HOSTED_LABEL[host]}: one that names these machines.`
      );
    }
  }
  return problems;
}

/** Whether a runner carries every one of the target's labels for its host. */
export function runnerFits(target: Pick<Target, 'labels'>, runner: Runner): boolean {
  const wanted = target.labels[runner.host];
  if (wanted.length === 0) return false;
  const has = new Set(runner.labels.map((l) => l.toLowerCase()));
  return wanted.every((label) => has.has(label.toLowerCase()));
}

export interface TargetHealth {
  total: number;
  online: number;
  /** Per host, the runners that fit. */
  byHost: Record<Host, Runner[]>;
}

export function targetHealth(
  target: Pick<Target, 'labels'>,
  runners: readonly Runner[]
): TargetHealth {
  const byHost: Record<Host, Runner[]> = { bitbucket: [], github: [] };
  for (const runner of runners) if (runnerFits(target, runner)) byHost[runner.host].push(runner);
  const all = [...byHost.bitbucket, ...byHost.github];
  return { total: all.length, online: all.filter((r) => r.status === 'online').length, byHost };
}

/** Runners no target takes. */
export function runnersInNoTarget(
  targets: readonly Pick<Target, 'labels'>[],
  runners: readonly Runner[]
): Runner[] {
  return runners.filter((runner) => !targets.some((target) => runnerFits(target, runner)));
}

/** The labels GitHub gives every self-hosted runner by itself (its OS and architecture). */
const GITHUB_DEFAULT_LABELS = new Set([
  'self-hosted',
  'linux',
  'windows',
  'macos',
  'x64',
  'arm64',
  'arm',
]);
const BITBUCKET_DEFAULT_LABELS = new Set([
  'self.hosted',
  'linux',
  'windows',
  'macos',
  'linux.shell',
  'linux.arm64',
]);

/**
 * A target made from one runner's labels, for "make a target from these":
 * named after the label that is the runner's own (not the host's
 * defaults), with that host's labels filled in.
 */
export function targetFromRunner(runner: Runner): { name: string; labels: TargetLabels } {
  const defaults = runner.host === 'github' ? GITHUB_DEFAULT_LABELS : BITBUCKET_DEFAULT_LABELS;
  const own = runner.labels.find((label) => !defaults.has(label.toLowerCase()));
  const name = (own ?? runner.name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const labels: TargetLabels = { bitbucket: [], github: [] };
  labels[runner.host] = runner.labels;
  return { name: /^[a-z]/.test(name) ? name : `runner-${name}`, labels };
}
