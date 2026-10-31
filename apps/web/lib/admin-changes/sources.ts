/**
 * Every admin connector's change requests as one list — the operator's
 * Changes page and the count beside it in the menu. Each connector keeps
 * its own table, review page and state machine (lib/salesforce-admin,
 * lib/jira-admin); this reads them through their own modules and shapes
 * each row alike, so the page needs no connector's types.
 *
 * A new admin connector with a change queue is one more entry in SOURCES:
 * how to list its requests (everyone's for an operator, one person's
 * otherwise), how many wait for review, and where each is.
 */

import * as salesforce from '@/lib/salesforce-admin/change-requests';
import * as jira from '@/lib/jira-admin/change-requests';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';
import { changePath, type AdminConnectorKey } from './notify';

/** The states every connector's requests share (both modules' ChangeRequestState). */
export type ChangeState = salesforce.ChangeRequestState;

export interface ChangeRow {
  source: AdminConnectorKey;
  /** "Salesforce", "Jira" — the badge on the row. */
  sourceLabel: string;
  id: string;
  title: string;
  /** The connector's own review page. */
  href: string;
  /** Which org or site it changes, when known. */
  where: string | null;
  /** A request in words, or a proposal that can be approved as it stands. */
  kind: 'request' | 'proposal';
  state: ChangeState;
  createdAt: Date;
  subject: string;
  agentId: string | null;
  /** What the job is doing, while queued or applying. */
  step: string | null;
  /** Salesforce's check-only deploy, for a Salesforce proposal; null otherwise. */
  validation: salesforce.Validation | null;
}

interface ChangeSource {
  key: AdminConnectorKey;
  label: string;
  list(input: { subject: string; operator: boolean; now: Date }): Promise<ChangeRow[]>;
  /** Requests waiting for an operator, unexpired. */
  countAwaitingReview(): Promise<number>;
}

const OPERATOR_LIMIT = 100;
const OWN_LIMIT = 50;

/** "https://acme.atlassian.net" → "acme.atlassian.net"; a malformed URL as it is. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const SALESFORCE: ChangeSource = {
  key: 'salesforce-admin',
  label: 'Salesforce',
  async list({ subject, operator, now }) {
    const [changes, orgs] = await Promise.all([
      operator
        ? salesforce.listAllChangeRequests({ limit: OPERATOR_LIMIT })
        : salesforce.listChangeRequests(subject, { limit: OWN_LIMIT }),
      listSalesforceConnectors(SALESFORCE_ADMIN_KIND),
    ]);
    const names = new Map(orgs.map((org) => [org.key, org.name]));
    return changes.map((change) => ({
      source: 'salesforce-admin',
      sourceLabel: 'Salesforce',
      id: change.id,
      title: change.title,
      href: changePath('salesforce-admin', change.id),
      where: names.get(change.connectorKey) ?? change.connectorKey,
      kind: change.kind === salesforce.REQUEST_KIND ? 'request' : 'proposal',
      state: salesforce.stateOf(change, now),
      createdAt: change.createdAt,
      subject: change.subject,
      agentId: change.agentId,
      step: change.step,
      validation: change.kind === salesforce.REQUEST_KIND ? null : change.validation,
    }));
  },
  async countAwaitingReview() {
    let total = 0;
    for (const count of (await salesforce.countAwaitingReview()).values()) total += count;
    return total;
  },
};

const JIRA: ChangeSource = {
  key: 'jira-admin',
  label: 'Jira',
  async list({ subject, operator, now }) {
    const changes = operator
      ? await jira.listAllChangeRequests({ limit: OPERATOR_LIMIT })
      : await jira.listChangeRequests(subject, { limit: OWN_LIMIT });
    return changes.map((change) => ({
      source: 'jira-admin',
      sourceLabel: 'Jira',
      id: change.id,
      title: change.title,
      href: changePath('jira-admin', change.id),
      where: change.siteUrl ? hostOf(change.siteUrl) : null,
      kind: change.kind === jira.REQUEST_KIND ? 'request' : 'proposal',
      state: jira.stateOf(change, now),
      createdAt: change.createdAt,
      subject: change.subject,
      agentId: change.agentId,
      step: change.step,
      validation: null,
    }));
  },
  countAwaitingReview: () => jira.countAwaitingReview(),
};

const SOURCES: readonly ChangeSource[] = [SALESFORCE, JIRA];

/** The connectors with a change queue, for the page's filter. */
export const CHANGE_SOURCES: readonly { key: AdminConnectorKey; label: string }[] = SOURCES.map(
  ({ key, label }) => ({ key, label })
);

export function isChangeSource(value: string | undefined): value is AdminConnectorKey {
  return SOURCES.some((source) => source.key === value);
}

/**
 * Every connector's requests, newest first (ties by id): an operator's are
 * everyone's, anyone else's their own. `source` narrows to one connector.
 */
export async function listChangeRows(input: {
  subject: string;
  operator: boolean;
  source?: AdminConnectorKey;
  now?: Date;
}): Promise<ChangeRow[]> {
  const now = input.now ?? new Date();
  const sources = SOURCES.filter((source) => !input.source || source.key === input.source);
  const lists = await Promise.all(
    sources.map((source) => source.list({ subject: input.subject, operator: input.operator, now }))
  );
  return lists
    .flat()
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
}

/** How many requests wait for an operator, across every connector — the menu's badge. */
export async function countChangesAwaitingReview(): Promise<number> {
  const counts = await Promise.all(SOURCES.map((source) => source.countAwaitingReview()));
  return counts.reduce((sum, count) => sum + count, 0);
}
