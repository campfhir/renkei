import { crawlId, type CrawlPage } from './types';

/**
 * Salesforce and Jira administration: the change queues (the crawl's
 * person is an operator, so they see every request) and the Jira space
 * templates. The detail pages show applied changes — a pending one would
 * also ask the apply gate, which reads connector availability outside
 * this area.
 */

const SALESFORCE_CHANGE = crawlId(601);
const JIRA_CHANGE = crawlId(602);
const TEMPLATE = crawlId(603);
const AT = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:05:00.000Z';
const EXPIRES = '2099-01-01T00:00:00.000Z';

function salesforceChange(subject: string) {
  return {
    salesforce_admin_change_requests: [
      {
        id: SALESFORCE_CHANGE,
        subject,
        connector_key: 'uat',
        org_id: '00D000000000062EAA',
        instance_url: 'https://acme--uat.sandbox.my.salesforce.com',
        kind: 'fields',
        title: 'Crawl Site Visit: add Outcome',
        reason: 'The crawl checks this page',
        payload: JSON.stringify({ components: [], dataSteps: [], preconditions: [] }),
        validation: JSON.stringify({
          deployId: '0Af000000000001',
          done: true,
          success: true,
          status: 'Succeeded',
          failures: [],
          checkedAt: AT,
        }),
        status: 'applied',
        results: JSON.stringify({
          deployId: '0Af000000000002',
          operations: [{ label: 'Crawl deploy 3 component(s)', outcome: 'done' }],
        }),
        expires_at: EXPIRES,
        created_at: AT,
        updated_at: LATER,
        applied_by: subject,
        applied_at: LATER,
        approved_by: subject,
        approved_at: AT,
      },
    ],
  };
}

function jiraChange(subject: string) {
  return {
    jira_admin_change_requests: [
      {
        id: JIRA_CHANGE,
        subject,
        cloud_id: 'crawl-cloud',
        site_url: 'https://crawl.atlassian.net',
        kind: 'request',
        title: 'Crawl Source: add Vendor',
        payload: JSON.stringify({ description: 'Add a Vendor option to Source' }),
        status: 'applied',
        results: JSON.stringify([{ label: 'Crawl add option Vendor', outcome: 'done' }]),
        expires_at: EXPIRES,
        created_at: AT,
        updated_at: LATER,
        applied_by: subject,
        applied_at: LATER,
      },
    ],
  };
}

export const adminChangesPages: CrawlPage[] = [
  {
    path: '/salesforce-admin/changes',
    seed: salesforceChange,
    expectText: 'Crawl Site Visit: add Outcome',
  },
  {
    path: `/salesforce-admin/changes/${SALESFORCE_CHANGE}`,
    seed: salesforceChange,
    expectText: 'Crawl deploy 3 component(s)',
  },
  {
    path: '/jira-admin/changes',
    seed: jiraChange,
    expectText: 'Crawl Source: add Vendor',
  },
  {
    path: `/jira-admin/changes/${JIRA_CHANGE}`,
    seed: jiraChange,
    expectText: 'Add a Vendor option to Source',
  },
  {
    // The view gate asks whether Jira Administration is connected, from
    // the person's grant (seeded here) — through lib/mcp-tools/registry.ts.
    path: '/jira-admin/templates',
    seed: (subject) => ({
      provider_grants: [
        {
          provider: 'atlassian-admin',
          provider_account_id: `crawl-${subject}`,
          subject,
          client_id: 'crawl',
          display_name: 'Crawl Jira admin',
          encrypted_access_token: 'sealed',
          encrypted_refresh_token: 'sealed',
          expires_at: EXPIRES,
          requested_scopes: ['read:jira-work', 'manage:jira-configuration'],
        },
      ],
      jira_admin_space_templates: [
        {
          id: TEMPLATE,
          cloud_id: 'crawl-cloud',
          site_url: 'https://crawl.atlassian.net',
          name: 'Crawl operations standard',
          name_key: 'crawl operations standard',
          document: JSON.stringify({
            version: 1,
            projectTypeKey: 'software',
            assigneeType: null,
            category: null,
            schemes: {
              issueTypeScheme: { id: '1', name: 'Crawl types' },
              issueTypeScreenScheme: { id: '2', name: 'Crawl screens' },
              workflowScheme: { id: '3', name: 'Crawl workflow' },
              fieldConfigurationScheme: null,
              permissionScheme: { id: '4', name: 'Crawl permissions' },
              notificationScheme: { id: '5', name: 'Crawl notifications' },
              issueSecurityScheme: null,
            },
            roles: [],
            components: [],
          }),
          created_by: subject,
          updated_by: subject,
        },
      ],
    }),
    expectText: 'Crawl operations standard',
  },
];
