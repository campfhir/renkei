/**
 * Renkei's own capability bundles for the Salesforce admin connector
 * (docs/salesforce-connectors-design.md, "Admin scope picker"), the same
 * bookkeeping as lib/salesforce-scopes.ts: Salesforce's `api` scope cannot
 * tell reading the org's setup from changing it, so these name nothing
 * Salesforce reads. They are what requested_scopes records and what the
 * tool gate (mcp-tools/salesforce-admin/scopes.ts) narrows by; the person's
 * own Salesforce permissions (Customize Application, Modify Metadata…)
 * still decide every call, and every change is a change request the person
 * applies in their browser.
 *
 * Only bundles with tools behind them are listed; the design's others
 * (layouts and apps, reports and dashboards, automation, permission sets,
 * user access, whole applications) join as their tools are built.
 */

import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';

export const SALESFORCE_ADMIN_SCOPE_GROUPS: ScopeGroup[] = [
  { id: 'read', label: 'Reading the org’s setup' },
  { id: 'build', label: 'Building' },
];

export const SALESFORCE_ADMIN_SCOPE_OPTIONS: ScopeOption[] = [
  {
    id: 'sfa-read',
    scopes: ['sfa-read'],
    label: 'Read org configuration',
    hint:
      'salesforce_admin_check_access, salesforce_admin_describe_object, salesforce_admin_get_field, ' +
      'salesforce_admin_list_validation_rules, salesforce_admin_list_change_requests — objects, ' +
      'fields, validation rules and where a field is used, as the person can see them in Setup.',
    userHint:
      'Read how the org is built — objects, fields, validation rules, where a field is used — and your own change requests.',
    group: 'read',
    defaultChecked: true,
  },
  {
    id: 'sfa-schema',
    scopes: ['sfa-schema'],
    label: 'Propose objects and fields',
    hint:
      'salesforce_admin_propose_fields, salesforce_admin_propose_validation_rule — each a change ' +
      'request, checked by a validation deploy in the org and applied only by the person, in ' +
      'their browser. Nothing on the MCP surface changes the org.',
    userHint:
      'Propose new fields and validation rules. Each is checked by Salesforce and waits for you to review and apply it in Renkei.',
    group: 'build',
    defaultChecked: true,
  },
];

export const ALL_SALESFORCE_ADMIN_SCOPES = [
  ...new Set(SALESFORCE_ADMIN_SCOPE_OPTIONS.flatMap((option) => option.scopes)),
];

export const DEFAULT_SALESFORCE_ADMIN_SCOPES = [
  ...new Set(
    SALESFORCE_ADMIN_SCOPE_OPTIONS.filter((option) => option.defaultChecked).flatMap(
      (option) => option.scopes
    )
  ),
].join(' ');

/** The stored ceiling, kept to known capabilities; the defaults when nothing usable is stored. */
export function usableSalesforceAdminCeiling(stored: string | null | undefined): string[] {
  const known = new Set(ALL_SALESFORCE_ADMIN_SCOPES);
  const usable = (stored ?? '').split(/\s+/).filter((scope) => known.has(scope));
  return usable.length > 0 ? [...new Set(usable)] : DEFAULT_SALESFORCE_ADMIN_SCOPES.split(' ');
}
