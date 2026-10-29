/**
 * Preview cards for OneNote: a section, a page, an addition to a page, and
 * a deletion. The notebook, section and page are named by id here — the
 * builder sees only the arguments — so each card says which and lets the
 * person reread what is about to be written.
 */

import type { PreviewBuilder } from './card';
import { text } from './card';

const ONENOTE = 'OneNote';

/** "your notebooks", or the site or group a call points at. */
function whose(args: Record<string, unknown>): string[] {
  const site = text(args.site);
  const groupId = text(args.groupId);
  if (site) return [`Site ${site}`];
  if (groupId) return [`Group ${groupId}`];
  return ['Your notebooks'];
}

export const ONENOTE_PREVIEWS: Record<string, PreviewBuilder> = {
  onenote_create_section: (args) => ({
    verb: 'Create',
    icon: 'folder',
    title: `Create the section “${text(args.name)}”`,
    subtitle: ONENOTE,
    confirmLabel: 'Create section',
    editable: [{ key: 'name', label: 'Section name' }],
    body: {
      kind: 'document',
      mode: 'create',
      type: 'section',
      titleKey: 'name',
      title: text(args.name),
      location: [...whose(args), `Notebook ${text(args.notebookId)}`],
    },
  }),

  onenote_create_page: (args) => ({
    verb: 'Create',
    icon: 'doc',
    title: `Create the page “${text(args.title)}”`,
    subtitle: ONENOTE,
    confirmLabel: 'Create page',
    editable: [
      { key: 'title', label: 'Title' },
      { key: 'markdown', label: 'Page', multiline: true },
    ],
    body: {
      kind: 'document',
      mode: 'create',
      type: 'page',
      titleKey: 'title',
      title: text(args.title),
      location: [...whose(args), `Section ${text(args.sectionId)}`],
      bodyKey: 'markdown',
      body: text(args.markdown),
      bodyLabel: 'Page (Markdown)',
    },
  }),

  onenote_append_to_page: (args) => ({
    verb: 'Add',
    icon: 'doc',
    title: text(args.position) === 'top' ? 'Add to the top of a page' : 'Add to the end of a page',
    subtitle: ONENOTE,
    confirmLabel: 'Add to page',
    editable: [{ key: 'markdown', label: 'Addition', multiline: true }],
    body: {
      kind: 'document',
      mode: 'append',
      type: 'page',
      title: `Page ${text(args.pageId)}`,
      location: whose(args),
      bodyKey: 'markdown',
      body: text(args.markdown),
      bodyLabel: 'Added (Markdown)',
      unchanged: 'Everything already on the page stays as it is.',
    },
  }),

  onenote_delete_page: (args) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: `Delete page ${text(args.pageId)}`,
    subtitle: ONENOTE,
    confirmLabel: 'Delete page',
    body: {
      kind: 'document',
      mode: 'delete',
      type: 'page',
      title: `Page ${text(args.pageId)}`,
      location: whose(args),
      versionNote:
        'OneNote keeps deleted pages in the notebook’s recycle bin for a while; Renkei cannot restore them.',
    },
  }),
};
