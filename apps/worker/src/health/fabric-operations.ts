/**
 * Fabric definition fetches nobody is watching.
 *
 * Getting a notebook's or pipeline's definition is a long-running
 * operation in Fabric (packages/connector-fabric). While the person's
 * browser has the operation's page open, its event stream asks Fabric
 * whenever the row is due and marks the row watched on every tick. This
 * sweep takes the rest: running rows that are due and that no stream has
 * touched for WATCH_WINDOW_MS (the page closed, the tab slept, the fetch
 * was started by a tool in a chat). It takes each row's lease first
 * (`claimDue`), looks once, and — when that look ends the operation —
 * tells the owner through the notification framework: a feed row and a
 * push in the app, Outlook and WebEx if they asked, each by their
 * `fabricDefinitionReady` preference. Only the poller that wrote the end
 * reports it (`finish` returns the row to one caller), and `markNotified`
 * makes the notification once-only even so.
 *
 * Also, hourly in effect, finished rows older than RETENTION_DAYS go: a
 * definition is a snapshot, re-fetched when wanted.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore, type FabricOperationRecord } from '@renkei/db';
import { loadKeyring } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { getNotificationPrefs } from '@renkei/user-prefs';
import {
  LEASE_SECONDS,
  advanceOperation,
  fabricApiBase,
  fabricGrantFetcher,
  kindLabel,
} from '@renkei/connector-fabric';
import { deliverToOwnerChannels } from '../handlers/owner-channels';
import { registrationUrl } from '../handlers/feed-url';
import { logger } from '../logger';
import { whoIs } from '../log-actor';

const COMPONENT = 'fabric/operations-sweep';

export const FABRIC_OPERATIONS_SWEEP_INTERVAL_MS = 15_000;
/** A row a stream touched this recently is that stream's to poll. */
export const WATCH_WINDOW_MS = 30_000;
/** Rows looked at per pass; the rest wait for the next. */
const BATCH = 25;
const RETENTION_DAYS = 7;
const RETENTION_EVERY_PASSES = Math.round((60 * 60_000) / FABRIC_OPERATIONS_SWEEP_INTERVAL_MS);

/** The `connector` a Fabric notification row wears. */
export const FABRIC_CONNECTOR = 'fabric';

export function operationPath(id: string): string {
  return `/fabric/operations/${id}`;
}

export function headlineFor(operation: FabricOperationRecord): string {
  const what = `${kindLabel(operation.kind)} “${operation.itemName || operation.itemId}”`;
  return operation.status === 'succeeded'
    ? `The definition of the ${what} is ready`
    : `Fabric could not give the definition of the ${what}`;
}

/** Tell the owner an operation ended while they were away. Never throws. */
export async function notifyFinished(operation: FabricOperationRecord): Promise<void> {
  const owner = await whoIs(operation.subject);
  try {
    if (!(await getDataStore().fabricOperations.markNotified(operation.id, new Date()))) return;
    const wanted = (await getNotificationPrefs(operation.subject)).fabricDefinitionReady;
    const headline = headlineFor(operation);
    const detail =
      operation.status === 'succeeded'
        ? `In “${operation.workspaceName}”.`
        : (operation.error ?? 'Fabric gave no reason.');
    if (wanted.app) {
      const id = randomUUID();
      await getDataStore().notifications.insert({
        id,
        subject: operation.subject,
        kind:
          operation.status === 'succeeded' ? 'fabric_definition_ready' : 'fabric_definition_failed',
        category: null,
        connector: FABRIC_CONNECTOR,
        tool: null,
        entity: 'definition',
        headline,
        refUrl: operationPath(operation.id),
        refId: operation.id,
        agentId: null,
        agentName: null,
        runId: null,
        meta: {
          operationId: operation.id,
          kind: operation.kind,
          status: operation.status,
          workspaceName: operation.workspaceName,
          itemName: operation.itemName,
          error: operation.error,
        },
      });
      const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
      if (keyResult.ok) {
        void sendPush(
          operation.subject,
          keyResult.val,
          {
            title: headline,
            body: detail,
            tag: `fabric:${operation.id}`,
            refUrl: operationPath(operation.id),
            notificationId: id,
          },
          {
            log: (message, meta) =>
              logger.warn(
                '{actor} was not reached by push about Fabric "{item}" ({outcome}): {error}',
                {
                  ...meta,
                  ...owner,
                  component: COMPONENT,
                  operationId: operation.id,
                  item: operation.itemName,
                  outcome: message,
                  error: meta.error ?? '',
                }
              ),
          }
        );
      }
    }
    if (wanted.email || wanted.webex) {
      const base = await registrationUrl();
      const link = base ? `${base}${operationPath(operation.id)}` : null;
      await deliverToOwnerChannels({
        ownerSubject: operation.subject,
        email: wanted.email,
        webex: wanted.webex,
        heading: headline,
        body: `${detail}${link ? `\n\nOpen it: ${link}` : ''}`,
        log: {
          component: COMPONENT,
          ...owner,
          operationId: operation.id,
          item: operation.itemName,
        },
      });
    }
  } catch (error) {
    logger.warn(
      '{actor}\'s Fabric definition of "{item}" ended, but they were not notified; its page still shows it: {error}',
      {
        component: COMPONENT,
        ...owner,
        operationId: operation.id,
        item: operation.itemName,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

export function createFabricOperationsSweep(options: { now?: () => Date } = {}) {
  const clock = options.now ?? (() => new Date());
  let passes = 0;
  return async function sweep(): Promise<void> {
    const store = getDataStore().fabricOperations;
    const now = clock();
    const claimed = await store.claimDue({
      now,
      leaseUntil: new Date(now.getTime() + LEASE_SECONDS * 1000),
      unwatchedSince: new Date(now.getTime() - WATCH_WINDOW_MS),
      limit: BATCH,
    });
    const base = fabricApiBase();
    for (const operation of claimed) {
      try {
        const advanced = await advanceOperation(
          operation,
          fabricGrantFetcher(operation.subject),
          base,
          clock()
        );
        if (advanced.finished && advanced.operation) {
          logger.info('{actor}\'s Fabric definition of "{item}" {outcome} while they were away', {
            component: COMPONENT,
            ...(await whoIs(operation.subject)),
            operationId: operation.id,
            item: operation.itemName,
            outcome: advanced.operation.status === 'succeeded' ? 'arrived' : 'failed',
          });
          await notifyFinished(advanced.operation);
        }
      } catch (error) {
        // The lease lapses and the next pass looks again.
        logger.warn(
          '{actor}\'s Fabric definition of "{item}" could not be checked this pass; it will be checked again: {error}',
          {
            component: COMPONENT,
            ...(await whoIs(operation.subject)),
            operationId: operation.id,
            item: operation.itemName,
            error: error instanceof Error ? error.message : String(error),
          }
        );
      }
    }
    passes += 1;
    if (passes % RETENTION_EVERY_PASSES === 1) {
      const deleted = await store.deleteFinishedBefore(
        new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000)
      );
      if (deleted > 0) {
        logger.info('deleted {count} finished Fabric operation(s) older than {days} days', {
          component: COMPONENT,
          count: deleted,
          days: RETENTION_DAYS,
        });
      }
    }
  };
}
