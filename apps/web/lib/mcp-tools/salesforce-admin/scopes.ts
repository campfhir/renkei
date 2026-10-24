/**
 * Which Renkei capability each salesforce_admin_ tool stands on
 * (lib/salesforce-admin-scopes.ts). Registration filters against the union
 * of the person's admin connections; each call is checked against the one
 * connection it runs on (salesforce/org-choice.ts).
 */
export function salesforceAdminScopeFor(toolName: string): string[] {
  switch (toolName) {
    // Which orgs exist and which the person connected: no capability needed.
    case 'salesforce_admin_list_orgs':
      return [];

    case 'salesforce_admin_check_access':
    case 'salesforce_admin_describe_object':
    case 'salesforce_admin_get_field':
    case 'salesforce_admin_list_validation_rules':
    case 'salesforce_admin_list_change_requests':
    case 'salesforce_admin_get_layout':
    case 'salesforce_admin_get_picklist':
    case 'salesforce_admin_get_record_type':
      return ['sfa-read'];

    // Asking for a change in words needs only what looking things up
    // needs: nothing can change from it (the approval is an operator's,
    // in the browser).
    case 'salesforce_admin_request_change':
      return ['sfa-read'];

    case 'salesforce_admin_propose_object':
    case 'salesforce_admin_propose_fields':
    case 'salesforce_admin_propose_field_changes':
    case 'salesforce_admin_propose_picklist_changes':
    case 'salesforce_admin_propose_validation_rule':
    case 'salesforce_admin_propose_record_type':
      return ['sfa-read', 'sfa-schema'];

    case 'salesforce_admin_propose_layout_changes':
      return ['sfa-read', 'sfa-layouts'];

    case 'salesforce_admin_list_permission_sets':
    case 'salesforce_admin_propose_permission_set':
      return ['sfa-read', 'sfa-permissions'];

    case 'salesforce_admin_propose_assignments':
      return ['sfa-read', 'sfa-user-access'];

    default:
      // A new tool missing its mapping registers for nobody — the loud,
      // fail-closed direction; the registration test names it.
      return ['__unmapped__'];
  }
}
