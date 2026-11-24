/**
 * A change worth telling someone about: a pipeline's deploy step reported
 * how a deployment went, or a deployed application's health changed — it
 * said so in a check-in, or it went quiet (health.ts). Pure, so the web
 * app that takes the report or the check-in, the worker's sweep that
 * notices the silence, and the worker's handler that tells people and
 * wakes agents share one shape and one wording. Tested in changes.test.ts.
 *
 * A change rides the events queue as `deployments/deployment.changed` or
 * `deployments/health.changed`. It names the project and the environment
 * and says what happened; it never carries a variable, a token or a body.
 */

import { isRecord, isString } from '@renkei/guards';
import { HEALTH_STATES, isTroubled, type HealthState } from './health';

/** The events queue source, and the agent trigger catalog's. */
export const DEPLOYMENTS_SOURCE = 'deployments';
export const DEPLOYMENT_CHANGED = 'deployment.changed';
export const HEALTH_CHANGED = 'health.changed';

export const DEPLOYMENT_STATUSES = ['started', 'succeeded', 'failed'] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export interface DeploymentChange {
  kind: 'deployment';
  projectId: string;
  environment: string;
  status: DeploymentStatus;
  /** The deployment's row, which one run keeps through its statuses. */
  deploymentId: string;
  commit: string;
  branch: string | null;
  runUrl: string | null;
  detail: string | null;
  /** When it was reported (ISO). */
  at: string;
}

export interface HealthChanged {
  kind: 'health';
  projectId: string;
  environment: string;
  state: HealthState;
  /** The state before, as last announced; null for a first check-in. */
  previous: string | null;
  /** Check-ins missed in a row; 0 when it just checked in. */
  missed: number;
  /** What the application last said of itself. */
  message: string | null;
  version: string | null;
  /** When it was noticed (ISO). */
  at: string;
}

export type DeploymentsChange = DeploymentChange | HealthChanged;

export function changeType(change: DeploymentsChange): string {
  return change.kind === 'deployment' ? DEPLOYMENT_CHANGED : HEALTH_CHANGED;
}

const text = (value: unknown): string | null => (isString(value) && value ? value : null);

/** A change as it came off the queue; null when it is not one. */
export function readChange(payload: unknown): DeploymentsChange | null {
  if (!isRecord(payload)) return null;
  const projectId = text(payload.projectId);
  const environment = text(payload.environment);
  const at = text(payload.at);
  if (!projectId || !environment || !at) return null;
  if (payload.kind === 'deployment') {
    const status = DEPLOYMENT_STATUSES.find((s) => s === payload.status);
    const deploymentId = text(payload.deploymentId);
    const commit = text(payload.commit);
    if (!status || !deploymentId || !commit) return null;
    return {
      kind: 'deployment',
      projectId,
      environment,
      status,
      deploymentId,
      commit,
      branch: text(payload.branch),
      runUrl: text(payload.runUrl),
      detail: text(payload.detail),
      at,
    };
  }
  if (payload.kind === 'health') {
    const state = HEALTH_STATES.find((s) => s === payload.state);
    if (!state) return null;
    return {
      kind: 'health',
      projectId,
      environment,
      state,
      previous: text(payload.previous),
      missed: typeof payload.missed === 'number' && payload.missed > 0 ? payload.missed : 0,
      message: text(payload.message),
      version: text(payload.version),
      at,
    };
  }
  return null;
}

/**
 * One name per change, the same however often it is delivered: a
 * deployment reaches each status once, and an environment enters a state
 * at one instant.
 */
export function changeId(change: DeploymentsChange): string {
  return change.kind === 'deployment'
    ? `deployment:${change.deploymentId}:${change.status}`
    : `health:${change.projectId}:${change.environment}:${change.state}:${change.at}`;
}

/** The settings a person has for these, in Preferences (`NotificationPrefs`). */
export const CHANGE_SETTINGS = [
  'deploymentFailed',
  'deploymentSucceeded',
  'appFailed',
  'appStopped',
  'appUnhealthy',
  'appLate',
  'appRecovered',
] as const;
export type ChangeSetting = (typeof CHANGE_SETTINGS)[number];

/**
 * Which setting decides whether a person hears of this change; null for
 * one nobody is told about (a deployment starting, an application's first
 * word, one saying it is about to stop).
 */
export function changeSetting(change: DeploymentsChange): ChangeSetting | null {
  if (change.kind === 'deployment') {
    if (change.status === 'failed') return 'deploymentFailed';
    return change.status === 'succeeded' ? 'deploymentSucceeded' : null;
  }
  switch (change.state) {
    case 'failed':
      return 'appFailed';
    case 'stopped':
      return 'appStopped';
    case 'error':
    case 'degraded':
      return 'appUnhealthy';
    case 'late':
      return 'appLate';
    case 'healthy':
      return isTroubled(change.previous) ? 'appRecovered' : null;
    default:
      return null;
  }
}

/** The notification row's kind: the setting, as rows spell kinds. */
export function changeKind(setting: ChangeSetting): string {
  return setting.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** The line a person reads first. */
export function changeHeadline(change: DeploymentsChange, project: string): string {
  const where = `${change.environment} of “${project}”`;
  if (change.kind === 'deployment') {
    if (change.status === 'failed') return `Deploying ${where} failed`;
    return change.status === 'succeeded' ? `${where} was deployed` : `${where} is being deployed`;
  }
  switch (change.state) {
    case 'failed':
      return `${where} has stopped checking in`;
    case 'stopped':
      return `${where} has stopped`;
    case 'error':
      return `${where} reports an error`;
    case 'degraded':
      return `${where} reports it is degraded`;
    case 'late':
      return `${where} may be failing`;
    case 'healthy':
      return isTroubled(change.previous) ? `${where} is healthy again` : `${where} is healthy`;
    case 'starting':
      return `${where} is starting`;
    case 'stopping':
      return `${where} is stopping`;
    default:
      return `${where} changed`;
  }
}

/** The line under it. */
export function changeDetail(change: DeploymentsChange): string {
  if (change.kind === 'deployment') {
    const commit = `Commit ${change.commit.slice(0, 7)}${change.branch ? ` on ${change.branch}` : ''}.`;
    return change.detail ? `${commit} ${change.detail}` : commit;
  }
  switch (change.state) {
    case 'failed':
      return `It missed ${change.missed} check-ins in a row.`;
    case 'late':
      return 'Its health check-in is overdue.';
    case 'stopped':
      return 'It said it was stopping, and has not checked in since.';
    default:
      return change.message ?? 'It checked in.';
  }
}

/** Where the change is looked at: the environment, on the project's page. */
export function changePath(change: DeploymentsChange): string {
  return `/code/${change.projectId}/environments?env=${encodeURIComponent(change.environment)}`;
}

/**
 * What an agent woken by the change is handed, as `trigger.*`. The keys
 * are the trigger catalog's (packages/agents), which a test there holds
 * to this list.
 */
export function changeVariables(
  change: DeploymentsChange,
  project: { name: string; repository: string | null }
): Record<string, string> {
  const shared = {
    changeId: changeId(change),
    projectId: change.projectId,
    project: project.name,
    repository: project.repository ?? '',
    environment: change.environment,
    summary: `${changeHeadline(change, project.name)}. ${changeDetail(change)}`,
    at: change.at,
  };
  if (change.kind === 'deployment') {
    return {
      ...shared,
      status: change.status,
      commit: change.commit,
      branch: change.branch ?? '',
      runUrl: change.runUrl ?? '',
      detail: change.detail ?? '',
    };
  }
  return {
    ...shared,
    state: change.state,
    previous: change.previous ?? '',
    missed: String(change.missed),
    message: change.message ?? '',
    version: change.version ?? '',
  };
}
