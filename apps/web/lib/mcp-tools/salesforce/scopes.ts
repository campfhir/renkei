/**
 * Which Renkei capability each salesforce_ tool stands on
 * (lib/salesforce-scopes.ts). Registration filters against the
 * connection's requested capabilities via withScopeGate — Salesforce's own
 * OAuth scope (`api`) cannot tell these apart, so this mapping is the
 * narrowing, and the person's Salesforce permissions decide every call.
 */
export function salesforceScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'salesforce_check_access':
    case 'salesforce_list_objects':
    case 'salesforce_describe_object':
    case 'salesforce_search':
    case 'salesforce_query':
    case 'salesforce_get_record':
    case 'salesforce_list_related':
    case 'salesforce_find_relationship_path':
    case 'salesforce_record_history':
    case 'salesforce_list_changes':
      return ['sf-records-read'];

    case 'salesforce_create_record':
    case 'salesforce_update_record':
    case 'salesforce_upsert_record':
    case 'salesforce_relate_records':
    case 'salesforce_log_activity':
    case 'salesforce_create_task':
    case 'salesforce_add_note':
    case 'salesforce_create_record_tree_preview':
    case 'salesforce_create_record_tree_confirm':
    case 'salesforce_update_records_preview':
    case 'salesforce_update_records_confirm':
      return ['sf-records-write'];

    case 'salesforce_delete_records_preview':
    case 'salesforce_delete_records_confirm':
      return ['sf-records-delete'];

    case 'salesforce_change_owner_preview':
    case 'salesforce_change_owner_confirm':
      return ['sf-records-owner'];

    case 'salesforce_find_reports':
    case 'salesforce_describe_report':
    case 'salesforce_run_report':
    case 'salesforce_run_report_async':
    case 'salesforce_get_report_results':
    case 'salesforce_find_dashboards':
    case 'salesforce_get_dashboard':
    case 'salesforce_refresh_dashboard':
      return ['sf-reports'];

    default:
      // A new tool missing its mapping registers for nobody — the loud,
      // fail-closed direction; the registration test names it.
      return ['__unmapped__'];
  }
}
