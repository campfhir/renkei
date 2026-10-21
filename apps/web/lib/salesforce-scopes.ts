/**
 * Renkei's own capability bundles for the Salesforce CRM connector, grouped
 * into checkboxes via ScopePicker — the GitHub shape, not Atlassian's.
 *
 * Salesforce's OAuth scopes are coarse: `api` is the whole REST surface, and
 * nothing narrower separates "update a contact" from "delete a thousand".
 * What Salesforce itself enforces is the person's own permissions (object
 * access, field-level security, sharing), on every call. So these "scopes"
 * name nothing Salesforce reads: they are Renkei's bookkeeping — what
 * requested_scopes records, and what the tool gate (salesforce/scopes.ts)
 * narrows by. The OAuth request always carries SALESFORCE_OAUTH_SCOPES.
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';

/** What the authorize URL asks Salesforce for: the REST API, a refresh token, the identity URL. */
export const SALESFORCE_OAUTH_SCOPES = 'api refresh_token id';

export const SALESFORCE_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'records', label: 'Records' },
  { id: 'reports', label: 'Reports and dashboards' },
];

export const SALESFORCE_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'sf-records-read',
    scopes: ['sf-records-read'],
    label: 'Read records',
    hint:
      'salesforce_check_access, salesforce_list_objects, salesforce_describe_object, ' +
      'salesforce_search, salesforce_query, salesforce_get_record, salesforce_list_related, ' +
      'salesforce_find_relationship_path, salesforce_record_history, salesforce_list_changes — ' +
      'any standard or custom object the person can see.',
    userHint:
      'Find and read records — standard and custom objects, their related records and history — with your own Salesforce access.',
    group: 'records',
    defaultChecked: true,
  },
  {
    id: 'sf-records-write',
    scopes: ['sf-records-write'],
    label: 'Create and update records',
    hint:
      'salesforce_create_record, salesforce_update_record, salesforce_upsert_record, ' +
      'salesforce_relate_records, salesforce_log_activity, salesforce_create_task, ' +
      'salesforce_add_note, and the salesforce_update_records and salesforce_create_record_tree ' +
      'preview/confirm pairs for many records at once (org read-only mode disables these regardless).',
    userHint:
      'Create and update records, log calls and tasks, and add notes. Changing many records at once is a card you confirm first.',
    group: 'records',
    defaultChecked: true,
  },
  {
    id: 'sf-records-delete',
    scopes: ['sf-records-delete'],
    label: 'Delete records',
    hint: 'salesforce_delete_records preview/confirm — every delete is a card naming the records and the child records that go with them; deleted records stay in the Recycle Bin for 15 days.',
    userHint:
      'Delete records — each delete is a card you confirm first, naming what goes with it. Salesforce keeps deleted records in its Recycle Bin for 15 days.',
    group: 'records',
    defaultChecked: false,
  },
  {
    id: 'sf-records-owner',
    scopes: ['sf-records-owner'],
    label: 'Change record owners',
    hint: 'salesforce_change_owner preview/confirm — reassigning records changes who can see them, so it is always a card.',
    userHint:
      'Reassign records to someone else — a card you confirm first, since it changes who can see them.',
    group: 'records',
    defaultChecked: false,
  },
  {
    id: 'sf-reports',
    scopes: ['sf-reports'],
    label: 'Find and run reports and dashboards',
    hint:
      'salesforce_find_reports, salesforce_describe_report, salesforce_run_report, ' +
      'salesforce_run_report_async, salesforce_get_report_results, salesforce_find_dashboards, ' +
      'salesforce_get_dashboard, salesforce_refresh_dashboard — read-only; building and sharing reports is the admin connector’s.',
    userHint:
      'Find and run the reports and dashboards you can see in Salesforce, and read their results.',
    group: 'reports',
    defaultChecked: true,
  },
];

export const ALL_SALESFORCE_SCOPES = [
  ...new Set(SALESFORCE_SCOPE_OPTIONS.flatMap((option) => option.scopes)),
];

export const DEFAULT_SALESFORCE_SCOPES = [
  ...new Set(
    SALESFORCE_SCOPE_OPTIONS.filter((option) => option.defaultChecked).flatMap(
      (option) => option.scopes
    )
  ),
].join(' ');

/**
 * The org's stored ceiling, kept to capabilities this catalog knows; the
 * defaults when nothing usable is stored.
 */
export function usableSalesforceCeiling(stored: string | null | undefined): string[] {
  const known = new Set(ALL_SALESFORCE_SCOPES);
  const usable = (stored ?? '').split(/\s+/).filter((scope) => known.has(scope));
  return usable.length > 0 ? [...new Set(usable)] : DEFAULT_SALESFORCE_SCOPES.split(' ');
}
