/**
 * Which classic scopes each jira_admin_ tool stands on — every scope its
 * calls document (docs/jira-cloud-rest-api-open-api-spec.json), since
 * Atlassian refuses a call missing any of them. Registration filters against
 * the grant via withScopeGate (AND semantics), so an org that unticked a
 * bundle (lib/atlassian-scopes.ts's ATLASSIAN_ADMIN_SCOPE_OPTIONS) simply
 * never sees the tools that needed it.
 *
 * Classic scopes are coarse: reading a field's contexts or a space's schemes
 * already takes manage:jira-configuration, reading a screen's tabs takes
 * manage:jira-project, and Plans reads take read:jira-work.
 */
export function jiraAdminScopeFor(toolName: string): string[] {
  switch (toolName) {
    // /myself (read:jira-user); /mypermissions and project search (read:jira-work).
    case 'jira_admin_check_access':
      return ['read:jira-user', 'read:jira-work'];

    // /field/search.
    case 'jira_admin_list_fields':
      return ['read:jira-work'];

    // /field/search and /issuetype to name things, contexts and options to
    // describe them.
    case 'jira_admin_get_field':
      return ['read:jira-work', 'manage:jira-configuration'];

    // The project and its roles and permission/notification schemes
    // (read:jira-work); the work type, workflow, screen and field
    // configuration schemes (manage:jira-configuration).
    case 'jira_admin_get_space_configuration':
      return ['read:jira-work', 'manage:jira-configuration'];

    // The Plans API — read:jira-work only; Jira checks Administer Jira. A
    // plan's lead is named through /user (read:jira-user).
    case 'jira_admin_list_plans':
      return ['read:jira-work'];
    case 'jira_admin_get_plan':
      return ['read:jira-user', 'read:jira-work'];

    // Proposing reads the field, its contexts and options, and names the
    // spaces a context covers (read:jira-work, manage:jira-configuration);
    // the option writes it proposes take manage:jira-configuration too, so
    // a grant without it could never apply what it proposed. The list tool
    // reads only Renkei's own table, but lives and dies with proposing.
    case 'jira_admin_propose_option_changes':
    case 'jira_admin_list_changes':
      return ['read:jira-work', 'manage:jira-configuration'];

    // Templates: reading a space in full — the project, its roles and its
    // permission, notification and security schemes (read:jira-work), and
    // its work type, screen, workflow and field configuration schemes
    // (manage:jira-configuration). Listing and deleting touch only Renkei's
    // table, but live and die with saving.
    case 'jira_admin_save_space_template':
    case 'jira_admin_list_space_templates':
    case 'jira_admin_delete_space_template':
    case 'jira_admin_compare_space_to_template':
      return ['read:jira-work', 'manage:jira-configuration'];

    // A new space: everything saving a template reads, plus the lead and
    // members (/user, /user/search, /group/bulk: read:jira-user), the key
    // and name checks (read:jira-work) and the site's roles (/role:
    // manage:jira-configuration) — and creating it and filling its roles,
    // on apply, is manage:jira-configuration too.
    case 'jira_admin_propose_space':
      return ['read:jira-user', 'read:jira-work', 'manage:jira-configuration'];

    // A field for a space: the space and the field search (read:jira-work);
    // contexts, options and the screens scheme mapping
    // (manage:jira-configuration); screen schemes, screens, their tabs and
    // which screens a field is on (manage:jira-project) — the same three
    // its apply writes stand on.
    case 'jira_admin_propose_space_field':
      return ['read:jira-work', 'manage:jira-configuration', 'manage:jira-project'];

    // A work type: the space and the site's work types (read:jira-work); the
    // system icons, the work type, screens and workflow schemes and their
    // mappings, and — on apply — creating the type, its icon and every
    // mapping (manage:jira-configuration). No screen is read, so not
    // manage:jira-project.
    case 'jira_admin_list_work_type_icons':
      return ['manage:jira-configuration'];
    case 'jira_admin_propose_work_type':
      return ['read:jira-work', 'manage:jira-configuration'];

    // Screens: the space (read:jira-work), the scheme lookups that find who
    // else shows a screen (manage:jira-configuration), and the screens, tabs
    // and fields themselves, read and — on apply — changed
    // (manage:jira-project).
    case 'jira_admin_get_space_screens':
    case 'jira_admin_propose_screen_changes':
      return ['read:jira-work', 'manage:jira-configuration', 'manage:jira-project'];

    // A request type reads only the space on this grant (read:jira-work);
    // the service desk is read and written on the Jira Service Management
    // grant, whose scopes index.ts checks before registering it.
    case 'jira_admin_propose_request_type':
      return ['read:jira-work'];

    // Automation runs on the person's Atlassian API token (index.ts offers
    // the tools only once one is saved); this grant names spaces and issues
    // by key (read:jira-work) and nothing more.
    case 'jira_admin_list_automation_rules':
    case 'jira_admin_get_automation_rule':
    case 'jira_admin_propose_automation_rule_state':
    case 'jira_admin_propose_automation_rule':
    case 'jira_admin_propose_automation_run':
      return ['read:jira-work'];

    // A tool nobody mapped stands on the whole admin set: registering it
    // for less could only produce 401s.
    default:
      return ['read:jira-work', 'manage:jira-configuration', 'manage:jira-project'];
  }
}
