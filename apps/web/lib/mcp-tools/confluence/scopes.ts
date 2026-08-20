/**
 * Which Confluence granular scope(s) each tool stands on — mirrors
 * outlookScopeFor in ../outlook/index.ts. Registration filters against the
 * grant via withScopeGate (AND semantics: every listed scope must be
 * present), so a bundle that always travels whole (see
 * apps/web/lib/atlassian-scopes.ts's ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS)
 * only needs one of its scopes named here to prove the whole bundle.
 */
export function confluenceScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'confluence_search':
    case 'confluence_search_users':
      return ['read:content-details:confluence'];

    case 'confluence_create_page':
    case 'confluence_update_page':
    case 'confluence_update_page_title':
    case 'confluence_move_page':
    case 'confluence_set_page_status':
      return ['write:page:confluence'];
    case 'confluence_delete_page':
      return ['delete:page:confluence'];

    case 'confluence_create_blogpost':
    case 'confluence_update_blogpost':
      return ['write:blogpost:confluence'];
    case 'confluence_delete_blogpost':
      return ['delete:blogpost:confluence'];
    case 'confluence_list_blogposts':
    case 'confluence_get_blogpost':
      return ['read:blogpost:confluence'];

    case 'confluence_list_labels':
      return ['read:label:confluence'];
    case 'confluence_add_label':
    case 'confluence_remove_label':
      return ['write:label:confluence'];

    case 'confluence_list_comments':
      return ['read:comment:confluence'];
    case 'confluence_add_comment':
    case 'confluence_update_comment':
      return ['write:comment:confluence'];
    case 'confluence_delete_comment':
      return ['delete:comment:confluence'];

    case 'confluence_list_tasks':
      return ['read:task:confluence'];
    case 'confluence_update_task_status':
      return ['write:task:confluence'];

    case 'confluence_list_attachments':
      return ['read:attachment:confluence'];
    case 'confluence_request_attachment_upload':
      return ['write:attachment:confluence'];
    case 'confluence_delete_attachment':
      return ['delete:attachment:confluence'];

    case 'confluence_create_database':
      return ['write:database:confluence'];
    case 'confluence_get_database':
      return ['read:database:confluence'];
    case 'confluence_delete_database':
      return ['delete:database:confluence'];

    case 'confluence_create_whiteboard':
      return ['write:whiteboard:confluence'];
    case 'confluence_get_whiteboard':
      return ['read:whiteboard:confluence'];
    case 'confluence_delete_whiteboard':
      return ['delete:whiteboard:confluence'];

    case 'confluence_get_page_properties':
      return ['read:content.property:confluence'];
    case 'confluence_set_page_property':
      return ['write:content.property:confluence'];

    case 'confluence_get_page_analytics':
      return ['read:analytics.content:confluence'];

    case 'confluence_list_spaces':
    case 'confluence_get_space':
      return ['read:space:confluence'];

    // A watch resolves the space now and polls its pages later, so both
    // reads must be present for it to be worth offering.
    case 'confluence_watch_space':
    case 'confluence_unwatch_space':
      return ['read:space:confluence', 'read:page:confluence'];
    // Listing watches touches only Renkei's own rows.
    case 'confluence_list_watches':
      return [];

    default:
      // list/get page tools (list_pages, get_page, list_page_versions, list_drafts)
      return ['read:page:confluence'];
  }
}
