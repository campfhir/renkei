/**
 * Which Graph scope each OneNote tool stands on.
 *
 * The Notes scopes split on WHOSE notebook, the way the Files scopes split
 * on whose drive (onedrive/scopes.ts has the full argument):
 *
 *   Notes.Read / Notes.ReadWrite            the caller's own notebooks
 *   Notes.Read.All / Notes.ReadWrite.All    notebooks on sites and in groups too
 *
 * That is a per-CALL distinction (the same onenote_list_pages reads the
 * caller's notebook or a team's, depending on the `site`/`groupId` it was
 * given), and registration gating is per-TOOL, so the tools gate on the
 * narrow scope — the common case — and a shared notebook without the broad
 * scope surfaces as a Graph 403 whose message says a scope is likely
 * missing. The catalog's "Write in shared notebooks" option bundles all
 * four, so one box satisfies every gate and lets Graph permit the rest.
 *
 * The preview/confirm twins the generic act-preview layer generates for
 * each write stand on the write's own scope, the Outlook arrangement.
 */
export function onenoteScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'onenote_create_section':
    case 'onenote_create_page':
    case 'onenote_append_to_page':
    case 'onenote_delete_page':
    case 'onenote_create_section_preview':
    case 'onenote_create_section_confirm':
    case 'onenote_create_page_preview':
    case 'onenote_create_page_confirm':
    case 'onenote_append_to_page_preview':
    case 'onenote_append_to_page_confirm':
    case 'onenote_delete_page_preview':
    case 'onenote_delete_page_confirm':
      return ['Notes.ReadWrite'];

    default:
      // onenote_list_notebooks, onenote_list_sections, onenote_list_pages,
      // onenote_read_page
      return ['Notes.Read'];
  }
}
