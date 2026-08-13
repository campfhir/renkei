/**
 * Which Graph scope each OneDrive tool stands on.
 *
 * Files.Read covers the caller's OWN drive only. Anything reaching into
 * another person's drive — the shared-with-me listing, and resolving a
 * pasted link that points somewhere else — needs Files.Read.All, which is a
 * meaningfully broader grant and is kept to the tools that truly need it.
 */
export function onedriveScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'onedrive_list_shared_with_me':
      return ['Files.Read.All'];

    case 'onedrive_upload_document':
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
