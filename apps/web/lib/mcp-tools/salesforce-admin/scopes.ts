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
      return ['sfa-read'];

    case 'salesforce_admin_propose_fields':
    case 'salesforce_admin_propose_validation_rule':
      return ['sfa-read', 'sfa-schema'];

    default:
      // A new tool missing its mapping registers for nobody — the loud,
      // fail-closed direction; the registration test names it.
      return ['__unmapped__'];
  }
}
