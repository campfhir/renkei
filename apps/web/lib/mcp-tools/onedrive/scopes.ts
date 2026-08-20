/**
 * Which Graph scope each OneDrive tool stands on.
 *
 * The Files scopes split on WHOSE drive, not on what you do:
 *
 *   Files.Read / Files.ReadWrite            the caller's own drive
 *   Files.Read.All / Files.ReadWrite.All    every drive they can reach
 *
 * That is a per-ITEM distinction, and registration gating is per-TOOL, so it
 * cannot be expressed here: the same `onedrive_rename_document` needs
 * Files.ReadWrite for your own file and Files.ReadWrite.All for one a
 * colleague shared with you. So the tools gate on the narrow scope — the
 * common case, and the one that does not over-grant — and reaching into
 * another drive without the broad scope surfaces as a Graph 403 whose
 * message says a scope is likely missing.
 *
 * The catalog's "Edit files shared with me" option resolves it from the
 * other end: it bundles all four Files scopes, so checking that one box both
 * satisfies every gate here and lets Graph permit the cross-drive write.
 */
export function onedriveScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'onedrive_list_shared_with_me':
      return ['Files.Read.All'];

    case 'onedrive_request_document_upload':
    case 'onedrive_create_folder':
    case 'onedrive_rename_document':
    case 'onedrive_move_document':
    case 'onedrive_copy_document':
    case 'onedrive_delete_document':
    case 'onedrive_share_document':
    case 'onedrive_add_user_to_document':
    case 'onedrive_remove_user_from_document':
      return ['Files.ReadWrite'];

    default:
      return ['Files.Read'];
  }
}
