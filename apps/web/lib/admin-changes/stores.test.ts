/**
 * The admin change queues over the data store, on the memory
 * implementation (the Postgres side is packages/db's differential suite and
 * the *.db.test.ts files beside these modules): a Salesforce request is its
 * owner's until an operator looks, counts per org only while it is pending
 * and unexpired, and is claimed once; a Jira proposal tells every operator
 * but its requester; a space template's name is taken once per site; and a
 * Salesforce grant reads as a connection without opening a token.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import * as salesforce from '@/lib/salesforce-admin/change-requests';
import * as jira from '@/lib/jira-admin/change-requests';
import {
  findSpaceTemplate,
  listSpaceTemplates,
  saveSpaceTemplate,
  type TemplateDocument,
} from '@/lib/jira-admin/space-templates';
import { EMPTY_POLICY } from '@renkei/connector-salesforce';
import { listSalesforceConnections } from '@/lib/salesforce-grants';

let store: MemoryDataStore;

beforeEach(() => {
  store = createMemoryDataStore();
  registerDataStore(store);
});

afterAll(() => {
  resetDataStore();
});

const proposal = (subject: string, connectorKey = 'uat') =>
  salesforce.createChangeRequest({
    subject,
    connectorKey,
    orgId: '00D000000000062EAA',
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    kind: 'fields',
    title: 'Site Visit: add Outcome',
    reason: '  outcomes  ',
    payload: { files: { 'package.xml': '<Package/>' } },
  });

describe('Salesforce change requests', () => {
  it('are their owner’s, count per org while pending, and are claimed once', async () => {
    const mine = await proposal('ann');
    await proposal('ann', 'prod');
    await proposal('bob');

    expect(mine).toMatchObject({ status: 'pending', reason: 'outcomes', validation: null });
    expect(await salesforce.getChangeRequest('bob', mine.id)).toBeNull();
    expect(await salesforce.getChangeRequest('ann', 'not-a-uuid')).toBeNull();
    expect((await salesforce.listChangeRequests('ann')).map((c) => c.connectorKey).sort()).toEqual([
      'prod',
      'uat',
    ]);
    expect(await salesforce.countPendingChangeRequests('ann')).toEqual(
      new Map([
        ['prod', 1],
        ['uat', 1],
      ])
    );
    expect(await salesforce.countAwaitingReview()).toEqual(
      new Map([
        ['prod', 1],
        ['uat', 2],
      ])
    );

    expect(await salesforce.claimChangeRequest('ann', mine.id)).toBe(true);
    expect(await salesforce.claimChangeRequest('ann', mine.id)).toBe(false);
    expect(await salesforce.countPendingChangeRequests('ann')).toEqual(new Map([['prod', 1]]));
    expect(
      await salesforce.finishChangeRequest(mine.id, {
        status: 'applied',
        results: { deployId: '0Af1', operations: [{ label: 'Deploy', outcome: 'done' }] },
        appliedBy: 'ann',
      })
    ).toBe(true);
    const done = await salesforce.getChangeRequestById(mine.id);
    expect(done).toMatchObject({ status: 'applied', appliedBy: 'ann', step: null });
    expect(done?.results?.deployId).toBe('0Af1');
  });

  it('reads an expired request as expired, and leaves it out of the counts', async () => {
    const change = await proposal('ann');
    store.tables.update('salesforce_admin_change_requests', (row) => row.id === change.id, {
      expires_at: new Date(Date.now() - 1000),
    });
    const stored = await salesforce.getChangeRequestById(change.id);
    expect(stored && salesforce.stateOf(stored)).toBe('expired');
    expect(await salesforce.countAwaitingReview()).toEqual(new Map());
    expect(await salesforce.queueChangeRequest(change.id, 'op')).toBe(false);
  });
});

describe('Jira change requests', () => {
  it('tell every operator but the requester that one is waiting', async () => {
    const expires = new Date(Date.now() + 3_600_000);
    await store.seed({
      sessions: [
        {
          id: crypto.randomUUID(),
          subject: 'ada',
          roles: ['renkei-operator'],
          expires_at: expires,
        },
        {
          id: crypto.randomUUID(),
          subject: 'grace',
          roles: ['renkei-operator'],
          expires_at: expires,
        },
        { id: crypto.randomUUID(), subject: 'bob', roles: ['renkei-user'], expires_at: expires },
      ],
    });
    const change = await jira.createRequest({
      subject: 'grace',
      cloudId: 'cloud-1',
      title: 'Add a Vendor option',
      description: 'Source needs Vendor',
    });
    expect(jira.requestDescription(change.payload)).toBe('Source needs Vendor');
    expect(await jira.countAwaitingReview()).toBe(1);

    let feed = await store.notifications.list('ada', { limit: 5 });
    for (let attempt = 0; feed.length === 0 && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      feed = await store.notifications.list('ada', { limit: 5 });
    }
    expect(feed.map((n) => n.refUrl)).toEqual([`/jira-admin/changes/${change.id}`]);
    expect(await store.notifications.list('grace', { limit: 5 })).toEqual([]);
    expect(await store.notifications.list('bob', { limit: 5 })).toEqual([]);
  });
});

describe('Jira space templates', () => {
  const DOCUMENT: TemplateDocument = {
    version: 1,
    projectTypeKey: 'software',
    assigneeType: null,
    category: null,
    schemes: {
      issueTypeScheme: { id: '1', name: 'Types' },
      issueTypeScreenScheme: { id: '2', name: 'Screens' },
      workflowScheme: { id: '3', name: 'Workflow' },
      fieldConfigurationScheme: null,
      permissionScheme: { id: '4', name: 'Permissions' },
      notificationScheme: { id: '5', name: 'Notifications' },
      issueSecurityScheme: null,
    },
    roles: [],
    components: [],
  };
  const save = (cloudId: string, name: string, overwrite = false) =>
    saveSpaceTemplate({ cloudId, name, document: DOCUMENT, subject: 'ann', overwrite });

  it('takes a name once per site, prefers this site’s by name, and lists by name', async () => {
    expect(await save('cloud-1', 'Ops')).toMatchObject({ ok: true, replaced: false });
    expect(await save('cloud-1', ' ops ')).toEqual({ ok: false, reason: 'exists' });
    expect(await save('cloud-2', 'Ops')).toMatchObject({ ok: true });
    expect(await save('cloud-1', 'alpha')).toMatchObject({ ok: true });

    expect((await findSpaceTemplate('cloud-2', 'OPS'))?.cloudId).toBe('cloud-2');
    expect((await findSpaceTemplate('cloud-1', 'ops'))?.cloudId).toBe('cloud-1');
    expect(await findSpaceTemplate('cloud-1', 'nothing')).toBeNull();
    expect((await listSpaceTemplates()).map((t) => `${t.cloudId}:${t.name}`)).toEqual([
      'cloud-1:alpha',
      expect.stringMatching(/:Ops$/),
      expect.stringMatching(/:Ops$/),
    ]);
  });
});

describe('Salesforce connections', () => {
  it('reads a person’s grants for a provider, naming the connector they are to', async () => {
    await store.seed({
      provider_grants: [
        {
          provider: 'salesforce-admin',
          provider_account_id: '00D000000000062EAA/005000000000001',
          subject: 'ann',
          client_id: 'client',
          display_name: 'Ann at UAT',
          encrypted_access_token: 'sealed',
          encrypted_refresh_token: 'sealed',
          expires_at: new Date(Date.now() + 3_600_000),
          metadata: JSON.stringify({
            connector: 'uat',
            instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
            username: 'ann@acme.test',
          }),
          requested_scopes: ['api'],
        },
      ],
    });
    const connections = await listSalesforceConnections(
      'ann',
      [
        {
          key: 'uat',
          name: 'UAT',
          myDomain: 'https://acme--uat.sandbox.my.salesforce.com',
          host: 'acme--uat.sandbox.my.salesforce.com',
          sandbox: true,
          enabled: true,
          clientId: 'c',
          scopes: [],
          policy: EMPTY_POLICY,
          productionChanges: false,
        },
      ],
      'salesforce-admin'
    );
    expect(connections).toEqual([
      expect.objectContaining({
        accountId: '00D000000000062EAA/005000000000001',
        connector: 'uat',
        displayName: 'Ann at UAT',
        requestedScopes: ['api'],
      }),
    ]);
    expect(await listSalesforceConnections('bob', [], 'salesforce-admin')).toEqual([]);
  });
});
