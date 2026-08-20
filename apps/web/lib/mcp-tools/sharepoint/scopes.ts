/**
 * Which Graph scope each SharePoint tool stands on.
 *
 * withScopeGate filters at REGISTRATION, so a tool whose scopes this user's
 * grant does not carry never appears in tools/list at all — no 403 waiting
 * inside. That makes the `default:` branch load-bearing: a new tool nobody
 * added here silently inherits it, so it returns the read scope, which is
 * the conservative direction (a read tool stays hidden until the user has
 * SharePoint at all; a write tool would be under-gated, which is why every
 * write tool below is listed explicitly).
 *
 * Every tool here sits on the Sites.* family. Site membership is
 * deliberately not offered at all: the only delegated route to it is
 * GroupMember.ReadWrite.All, a directory-wide grant that is far too much
 * authority for a general user (see sites.ts).
 */
export function sharepointScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'sharepoint_create_page':
    case 'sharepoint_update_page':
    case 'sharepoint_publish_page':
    case 'sharepoint_delete_page':
    case 'sharepoint_request_document_upload':
    case 'sharepoint_rename_document':
    case 'sharepoint_move_document':
    case 'sharepoint_copy_document':
    case 'sharepoint_delete_document':
    case 'sharepoint_create_folder':
    case 'sharepoint_update_document_metadata':
    case 'sharepoint_share_document':
    case 'sharepoint_add_user_to_document':
    case 'sharepoint_remove_user_from_document':
      return ['Sites.ReadWrite.All'];

    // Watching a library indexes it for OTHER readers to find, so it needs
    // the scope the background sync will actually poll with.
    case 'sharepoint_watch_library':
    case 'sharepoint_unwatch_library':
      return ['Sites.Read.All'];

    default:
      return ['Sites.Read.All'];
  }
}
