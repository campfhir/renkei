/**
 * Which capability(ies) each tool stands on — mirrors bitbucketScopeFor in
 * ../bitbucket/scopes.ts. Registration filters against the connection's
 * requested ∩ granted set via withScopeGate, and GitHubAuth.fetch
 * enforces the same list at call time.
 */
export function githubScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'github_list_accounts':
    case 'github_list_repositories':
    case 'github_get_repository':
    case 'github_list_branches':
    case 'github_list_tags':
    case 'github_list_commits':
    case 'github_get_commit':
    case 'github_get_diff':
    case 'github_browse_source':
    case 'github_read_file':
    case 'github_read_files':
    case 'github_search_code':
      return ['repository'];

    case 'github_create_branch':
    case 'github_delete_branch':
    case 'github_commit_file':
    case 'github_commit_files':
      return ['repository:write'];

    case 'github_list_pull_requests':
    case 'github_get_pull_request':
    case 'github_get_pull_request_diff':
    case 'github_list_pr_comments':
      return ['pullrequest'];

    case 'github_create_pull_request':
    case 'github_create_pull_request_preview':
    case 'github_create_pull_request_confirm':
    case 'github_update_pull_request':
    case 'github_approve_pull_request':
    case 'github_request_pr_changes':
    case 'github_merge_pull_request':
    case 'github_merge_pull_request_preview':
    case 'github_merge_pull_request_confirm':
    case 'github_close_pull_request':
    case 'github_add_pr_comment':
    case 'github_resolve_pr_comment':
      return ['pullrequest:write'];

    case 'github_list_workflows':
    case 'github_list_workflow_runs':
    case 'github_get_workflow_run':
    case 'github_get_workflow_job_log':
      return ['actions'];

    case 'github_trigger_workflow':
    case 'github_trigger_workflow_preview':
    case 'github_trigger_workflow_confirm':
    case 'github_cancel_workflow_run':
      return ['actions:write'];

    case 'github_list_repository_collaborators':
    case 'github_grant_repository_permission':
    case 'github_revoke_repository_permission':
      return ['repository:admin'];

    default:
      // A new tool missing its mapping registers for nobody — the loud,
      // fail-closed direction; the registration test names it.
      return ['__unmapped__'];
  }
}
