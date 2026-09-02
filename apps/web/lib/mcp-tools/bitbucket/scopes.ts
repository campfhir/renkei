/**
 * Which Bitbucket scope(s) each tool stands on — mirrors confluenceScopeFor
 * in ../confluence/scopes.ts. Registration filters against the connection's
 * requested ∩ granted set via withScopeGate, and BitbucketAuth.fetch
 * enforces the same list at call time.
 *
 * Two places are deliberately STRICTER than what api.bitbucket.org itself
 * would accept, because our scope checkboxes read as read/write splits:
 * posting a PR comment or task needs only `pullrequest` at Bitbucket, and
 * triggering a pipeline only `pipeline` — but a grant a user narrowed to
 * "read pull requests" or "read pipelines" must stay read-only here, so
 * those act tools stand on the :write scope of their family.
 */
export function bitbucketScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'bitbucket_list_workspaces':
    case 'bitbucket_list_workspace_members':
      return ['account'];
    case 'bitbucket_list_projects':
    case 'bitbucket_get_project':
      return ['project'];

    // The permission LISTING is here too — a read, but of ACCESS
    // configuration, and its endpoint demands the admin scope anyway.
    case 'bitbucket_create_project':
    case 'bitbucket_update_project':
    case 'bitbucket_delete_project':
    case 'bitbucket_list_project_permissions':
      return ['project:admin'];

    case 'bitbucket_list_repository_permissions':
    case 'bitbucket_grant_repository_permission':
    case 'bitbucket_revoke_repository_permission':
      return ['repository:admin'];

    case 'bitbucket_list_repositories':
    case 'bitbucket_get_repository':
    case 'bitbucket_list_branches':
    case 'bitbucket_list_tags':
    case 'bitbucket_list_commits':
    case 'bitbucket_get_commit':
    case 'bitbucket_get_diff':
    case 'bitbucket_browse_source':
    case 'bitbucket_read_file':
    case 'bitbucket_read_files':
    case 'bitbucket_search_code':
      return ['repository'];

    case 'bitbucket_create_branch':
    case 'bitbucket_delete_branch':
    case 'bitbucket_commit_file':
    case 'bitbucket_commit_files':
      return ['repository:write'];

    case 'bitbucket_list_pull_requests':
    case 'bitbucket_get_pull_request':
    case 'bitbucket_get_pull_request_diff':
    case 'bitbucket_list_pr_comments':
    case 'bitbucket_list_pr_tasks':
    case 'bitbucket_list_default_reviewers':
      return ['pullrequest'];

    // The last three (comment, resolve, task) are looser at Bitbucket
    // (`pullrequest` suffices there); ours stand on :write so a read-only
    // PR grant stays read-only (see header).
    case 'bitbucket_create_pull_request':
    case 'bitbucket_create_pull_request_preview':
    case 'bitbucket_create_pull_request_confirm':
    case 'bitbucket_update_pull_request':
    case 'bitbucket_approve_pull_request':
    case 'bitbucket_request_pr_changes':
    case 'bitbucket_merge_pull_request':
    case 'bitbucket_merge_pull_request_preview':
    case 'bitbucket_merge_pull_request_confirm':
    case 'bitbucket_decline_pull_request':
    case 'bitbucket_add_pr_comment':
    case 'bitbucket_resolve_pr_comment':
    case 'bitbucket_add_pr_task':
      return ['pullrequest:write'];

    case 'bitbucket_list_pipelines':
    case 'bitbucket_get_pipeline':
    case 'bitbucket_get_pipeline_step_log':
      return ['pipeline'];

    // Trigger needs only `pipeline` at Bitbucket; ours stands on :write
    // (see header). Stop genuinely requires it.
    case 'bitbucket_trigger_pipeline':
    case 'bitbucket_trigger_pipeline_preview':
    case 'bitbucket_trigger_pipeline_confirm':
    case 'bitbucket_stop_pipeline':
      return ['pipeline:write'];

    default:
      // A new tool missing its mapping registers for nobody — the loud,
      // fail-closed direction; the registration test names it.
      return ['__unmapped__'];
  }
}
