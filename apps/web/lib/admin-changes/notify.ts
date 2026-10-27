/**
 * Telling people about admin change requests (Salesforce and Jira), the
 * "someone is waiting on you" and "your change finished" pings.
 *
 * Two audiences. A new request goes to every operator — the people who
 * approve — except the one who filed it, who is looking at it already.
 * How a queued change ended goes to whoever asked for it and to the
 * operator who approved it, because approving no longer holds a browser
 * open: the page they clicked on is long gone by the time Salesforce or
 * Jira answers, and the failure has to find them.
 *
 * Neither is gated on a preference: like a chat's permission ask, the
 * request is parked behind someone's answer, so the row always lands and
 * the push always goes out. Both are best-effort in the sense every
 * notification write is: a failure here costs reach, never correctness,
 * and never throws into the caller.
 *
 * Operators are the subjects Renkei holds a record of with the operator
 * role — a browser session or an MCP token minted while they held it. The
 * IdP's role claim is read at sign-in and kept nowhere else, so an operator
 * who has never signed in since roles were recorded cannot be found.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import { loadKeyring } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { ROLE_OPERATOR } from '@/lib/access';
import { logger } from '@/lib/logger';

export const CHANGE_REQUEST_NOTIFICATION_KIND = 'change_request';
export const CHANGE_RESULT_NOTIFICATION_KIND = 'change_result';

export type AdminConnectorKey = 'salesforce-admin' | 'jira-admin';

const CONNECTOR_LABELS: Record<AdminConnectorKey, string> = {
  'salesforce-admin': 'Salesforce',
  'jira-admin': 'Jira',
};

/** Where a change request is reviewed. */
export function changePath(connector: AdminConnectorKey, changeId: string): string {
  return `/${connector}/changes/${changeId}`;
}

/** Every subject Renkei knows to hold the operator role. */
export async function operatorSubjects(): Promise<string[]> {
  return getDataStore().adminChangeQueue.operatorSubjects(ROLE_OPERATOR);
}

async function notify(input: {
  subject: string;
  kind: string;
  connector: AdminConnectorKey;
  headline: string;
  body: string;
  path: string;
  changeId: string;
}): Promise<void> {
  const id = randomUUID();
  await getDataStore().adminChangeQueue.recordNotice({
    id,
    subject: input.subject,
    kind: input.kind,
    connector: input.connector,
    entity: 'change request',
    headline: input.headline,
    refId: input.changeId,
    refUrl: input.path,
  });
  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) return;
  void sendPush(
    input.subject,
    keyResult.val,
    {
      title: input.headline,
      body: input.body,
      tag: `change:${input.changeId}`,
      refUrl: input.path,
      notificationId: id,
      appPath: input.path,
    },
    { log: (message, meta) => logger.warn(message, meta) }
  );
}

function swallow(what: string, changeId: string): (error: unknown) => void {
  return (error) =>
    logger.warn(`${what} notification not recorded`, {
      component: 'admin-changes/notify',
      changeId,
      error: error instanceof Error ? error.message : String(error),
    });
}

/** A request is waiting: tell every operator but the person who filed it. */
export function notifyOperatorsOfRequest(input: {
  connector: AdminConnectorKey;
  changeId: string;
  title: string;
  requester: string;
  /** A free-text ask rather than a ready proposal. */
  freeText: boolean;
}): void {
  void (async () => {
    const label = CONNECTOR_LABELS[input.connector];
    const recipients = (await operatorSubjects()).filter((subject) => subject !== input.requester);
    const headline = input.freeText
      ? `A ${label} change was requested: ${input.title}`
      : `A ${label} change is waiting for your approval: ${input.title}`;
    await Promise.all(
      recipients.map((subject) =>
        notify({
          subject,
          kind: CHANGE_REQUEST_NOTIFICATION_KIND,
          connector: input.connector,
          headline,
          body: input.freeText ? 'Review the request' : 'Review it and approve to deploy',
          path: changePath(input.connector, input.changeId),
          changeId: input.changeId,
        }).catch(swallow('change request', input.changeId))
      )
    );
  })().catch(swallow('change request', input.changeId));
}

/** A queued change ended: tell the person who asked and the operator who approved. */
export function notifyChangeOutcome(input: {
  connector: AdminConnectorKey;
  changeId: string;
  title: string;
  requester: string;
  approver: string | null;
  outcome: 'applied' | 'partial' | 'failed' | 'declined' | 'proposed';
  /** Why it was declined. */
  note?: string | null;
}): void {
  void (async () => {
    const label = CONNECTOR_LABELS[input.connector];
    const headline =
      input.outcome === 'applied'
        ? `Your ${label} change was applied: ${input.title}`
        : input.outcome === 'partial'
          ? `Your ${label} change was partly applied: ${input.title}`
          : input.outcome === 'declined'
            ? `Your ${label} change request was declined: ${input.title}`
            : input.outcome === 'proposed'
              ? `Your ${label} change request was built into a proposal: ${input.title}`
              : `Your ${label} change failed: ${input.title}`;
    const body =
      input.outcome === 'declined'
        ? (input.note ?? 'Open it to see why')
        : input.outcome === 'proposed'
          ? 'It now waits for an operator’s approval'
          : input.outcome === 'applied'
            ? 'Open it to see what ran'
            : 'Open it to see what went wrong';
    const recipients = new Set([input.requester]);
    if (input.approver) recipients.add(input.approver);
    await Promise.all(
      [...recipients].map((subject) =>
        notify({
          subject,
          kind: CHANGE_RESULT_NOTIFICATION_KIND,
          connector: input.connector,
          // The approver reads "the change you approved", not "your change".
          headline: subject === input.requester ? headline : headline.replace(/^Your /, 'The '),
          body,
          path: changePath(input.connector, input.changeId),
          changeId: input.changeId,
        }).catch(swallow('change outcome', input.changeId))
      )
    );
  })().catch(swallow('change outcome', input.changeId));
}
