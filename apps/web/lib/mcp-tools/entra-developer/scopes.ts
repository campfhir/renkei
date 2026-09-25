/**
 * Which delegated Graph scope each entra_ tool stands on. withScopeGate
 * filters at REGISTRATION with AND semantics, so a tool whose scopes the
 * grant lacks never appears in tools/list — no 403 waiting inside — and an
 * org that unticked a bundle (lib/entra-developer-scopes.ts) simply never
 * sees the tools that needed it.
 *
 * The `default:` branch is load-bearing: a new write tool nobody mapped
 * stands on the whole write set, which can only hide it, never under-gate
 * it.
 */
export function entraScopeFor(toolName: string): string[] {
  switch (toolName) {
    // /me is User.Read, which the structural scopes always carry; the
    // probe reads that follow report per scope rather than gate on one.
    case 'entra_check_access':
      return [];

    // Resource APIs' scopes and roles are read off their service
    // principals, an app's granted application permissions off its own —
    // all Application.Read.All.
    case 'entra_list_applications':
    case 'entra_get_application':
    case 'entra_list_enterprise_applications':
    case 'entra_get_enterprise_application':
    case 'entra_portal_links':
    case 'entra_search_api_permissions':
    case 'entra_list_api_permissions':
      return ['Application.Read.All'];

    case 'entra_search_users':
      return ['User.ReadBasic.All'];
    case 'entra_search_groups':
      return ['Group.Read.All'];

    // Creating and changing applications, enterprise applications and app
    // roles; the preview half reads what it is about to change.
    case 'entra_create_application_preview':
    case 'entra_create_application_confirm':
    case 'entra_update_application_preview':
    case 'entra_update_application_confirm':
    case 'entra_create_enterprise_application_preview':
    case 'entra_create_enterprise_application_confirm':
    case 'entra_add_app_roles_preview':
    case 'entra_add_app_roles_confirm':
    case 'entra_remove_app_role_preview':
    case 'entra_remove_app_role_confirm':
    case 'entra_add_api_permissions_preview':
    case 'entra_add_api_permissions_confirm':
    case 'entra_remove_api_permissions_preview':
    case 'entra_remove_api_permissions_confirm':
    case 'entra_add_api_scope_preview':
    case 'entra_add_api_scope_confirm':
    case 'entra_remove_api_scope_preview':
    case 'entra_remove_api_scope_confirm':
      return ['Application.ReadWrite.All'];

    // Assignments read the enterprise application's roles (Application.Read.All)
    // and write the assignment (AppRoleAssignment.ReadWrite.All).
    case 'entra_assign_app_role_preview':
    case 'entra_assign_app_role_confirm':
    case 'entra_remove_app_role_assignment_preview':
    case 'entra_remove_app_role_assignment_confirm':
      return ['Application.Read.All', 'AppRoleAssignment.ReadWrite.All'];

    default:
      return ['Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All'];
  }
}
