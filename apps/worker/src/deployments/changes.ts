/**
 * Telling people, and their agents, that a deployment or a deployed
 * application's health changed.
 *
 * The web app enqueues a change when a pipeline's deploy step reports
 * (lib/ci/deployment-reports.ts) or an application's check-in says
 * something new (lib/ci/health.ts); the sweep beside this file enqueues
 * one when an application goes quiet. This handler takes each off the
 * events queue (`deployments/deployment.changed`, `…/health.changed`) and,
 * for the code project's owner and everyone it is shared with:
 *
 *   - leaves them alone unless they have a Bitbucket or GitHub connection —
 *     deployments are part of working on a repository, and someone who
 *     cannot reach one is not shown its pipeline either;
 *   - notifies them as their Preferences say (the Deployments card): a
 *     feed row and a push in the app, Outlook and WebEx if asked. Failed
 *     deployments and applications that failed, stopped or report a
 *     problem are on unless switched off; the rest are off unless
 *     switched on;
 *   - wakes their agents that listen for the change (the trigger catalog's
 *     `deployments/*` events), whatever their notification settings.
 *
 * One person failing to be reached never costs the others: each is tried
 * on their own, and the change's own name (`changeId`) keeps an agent from
 * being woken twice if the message is delivered again. What a change
 * carries is in @renkei/ci-blocks (changes.ts): never a variable or token.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import { loadKeyring } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { agentJobsQueue } from '@renkei/queue';
import { fanOutAgentEvents } from '@renkei/agents/event-fanout';
import {
  DEPLOYMENTS_SOURCE,
  changeDetail,
  changeHeadline,
  changeId,
  changeKind,
  changePath,
  changeSetting,
  changeType,
  changeVariables,
  readChange,
  type DeploymentsChange,
} from '@renkei/ci-blocks';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { deliverToOwnerChannels } from '../handlers/owner-channels';
import { registrationUrl } from '../handlers/feed-url';
import type { EventHandler } from '../handlers';
import { logger } from '../logger';
import { whoIs } from '../log-actor';

const COMPONENT = 'deployments/changes';
/** The `connector` a deployment notification row wears, and the tools' key. */
export const DEPLOYMENTS_CONNECTOR = 'deployments';

const queue = agentJobsQueue();

/** Whether this person has a code host connected: Bitbucket or GitHub. */
export async function hasCodeHost(subject: string): Promise<boolean> {
  const grants = getDataStore().providerGrants;
  for (const provider of [ATLASSIAN_BITBUCKET, GITHUB]) {
    if ((await grants.listForSubject(subject, { provider })).length > 0) return true;
  }
  return false;
}

/** The project's owner and everyone it is shared with, each once, the owner first. */
export async function peopleOf(projectId: string, ownerSubject: string): Promise<string[]> {
  const shared = await getDataStore().resourceGrants.activeGrantees('chat_project', projectId);
  return [...new Set([ownerSubject, ...shared])];
}

async function notify(
  subject: string,
  change: DeploymentsChange,
  project: { id: string; name: string }
): Promise<boolean> {
  const setting = changeSetting(change);
  if (!setting) return false;
  const wanted = (await getNotificationPrefs(subject))[setting];
  if (!wanted.app && !wanted.email && !wanted.webex) return false;
  const person = await whoIs(subject);
  const headline = changeHeadline(change, project.name);
  const detail = changeDetail(change);
  const path = changePath(change);
  const said = {
    component: COMPONENT,
    ...person,
    projectId: project.id,
    project: project.name,
    environment: change.environment,
    change: changeId(change),
  };
  if (wanted.app) {
    const id = randomUUID();
    await getDataStore().notifications.insert({
      id,
      subject,
      kind: changeKind(setting),
      category: null,
      connector: DEPLOYMENTS_CONNECTOR,
      tool: null,
      entity: 'environment',
      headline,
      refUrl: path,
      refId: project.id,
      agentId: null,
      agentName: null,
      runId: null,
      meta:
        change.kind === 'deployment'
          ? {
              projectId: project.id,
              project: project.name,
              environment: change.environment,
              status: change.status,
              commit: change.commit,
              branch: change.branch,
              runUrl: change.runUrl,
              detail,
            }
          : {
              projectId: project.id,
              project: project.name,
              environment: change.environment,
              state: change.state,
              previous: change.previous,
              missed: change.missed,
              detail,
            },
    });
    const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
    if (keyResult.ok) {
      void sendPush(
        subject,
        keyResult.val,
        {
          title: headline,
          body: detail,
          tag: `deployments:${project.id}:${change.environment}`,
          refUrl: path,
          notificationId: id,
        },
        {
          log: (message, meta) =>
            logger.warn(
              '{actor} was not reached by push about {environment} of "{project}" ({outcome}): {error}',
              { ...meta, ...said, outcome: message, error: meta.error ?? '' }
            ),
        }
      );
    }
  }
  if (wanted.email || wanted.webex) {
    const base = await registrationUrl();
    await deliverToOwnerChannels({
      ownerSubject: subject,
      email: wanted.email,
      webex: wanted.webex,
      heading: headline,
      body: `${detail}${base ? `\n\nOpen it: ${base}${path}` : ''}`,
      log: said,
    });
  }
  return true;
}

export interface Announced {
  /** People with a code host connection: who the change was for. */
  people: number;
  notified: number;
  /** Agent runs started. */
  runs: number;
}

/** Tell everyone the change is for, and wake their agents. Never throws for one person's sake. */
export async function announceChange(change: DeploymentsChange): Promise<Announced | null> {
  const store = getDataStore();
  const project = await store.chatProjects.get(change.projectId);
  // The project went between the change and now: nobody is left to tell.
  if (!project) return null;
  const variables = changeVariables(change, {
    name: project.name,
    repository: project.repoFullName,
  });
  const result: Announced = { people: 0, notified: 0, runs: 0 };
  for (const subject of await peopleOf(project.id, project.ownerSubject)) {
    try {
      if (!(await hasCodeHost(subject))) continue;
      result.people += 1;
      if (await notify(subject, change, project)) result.notified += 1;
      const person = await whoIs(subject);
      const { started } = await fanOutAgentEvents(
        queue.producer,
        {
          source: DEPLOYMENTS_SOURCE,
          type: changeType(change),
          ownerSubject: subject,
          payload: variables,
        },
        { log: (message, meta) => logger.debug(message, { ...meta, ...person }) }
      );
      result.runs += started.length;
    } catch (error) {
      logger.warn(
        '{actor} was not told that {environment} of "{project}" changed ({change}), and none of their agents was woken for it: {error}',
        {
          component: COMPONENT,
          ...(await whoIs(subject)),
          projectId: project.id,
          project: project.name,
          environment: change.environment,
          change: changeId(change),
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }
  logger.info(
    '{environment} of "{project}" changed ({change}): {notified} of {people} people with a code host connection were notified, and {runs} agent run(s) started',
    {
      component: COMPONENT,
      ...(await whoIs(project.ownerSubject)),
      projectId: project.id,
      project: project.name,
      environment: change.environment,
      change: changeId(change),
      ...result,
    }
  );
  return result;
}

export function createDeploymentsChangeHandler(): EventHandler {
  return async (event) => {
    const change = readChange(event.payload);
    if (!change) throw new Error('deployments change payload is not a deployment or health change');
    return (await announceChange(change)) ? undefined : 'skipped';
  };
}
