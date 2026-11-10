/**
 * Preview cards for OneNote: a section, a page, an addition to a page, and
 * a deletion. The notebook, section and page arrive as ids; the lookup
 * (onenote/preview-lookups.ts) names them, and where it could not the card
 * says "the page", never the id.
 */

import type { Names, PreviewBuilder } from './card';
import { named, text } from './card';
import { siteLabel } from './graph-names';

const ONENOTE = 'OneNote';

/** "your notebooks", or the site or group a call points at. */
function whose(args: Record<string, unknown>, names: Names): string[] {
  if (text(args.site)) {
    const site = siteLabel(names, args.site);
    return [site ? `Site ${site}` : 'A SharePoint site'];
  }
  if (text(args.groupId)) {
    const group = named(names, 'group', args.groupId);
    return [group ? `Group ${group}` : 'A Microsoft 365 group'];
  }
  return ['Your notebooks'];
}

export const ONENOTE_PREVIEWS: Record<string, PreviewBuilder> = {
  onenote_create_section: (args, names) => ({
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
      location: [
        ...whose(args, names),
        named(names, 'notebook', args.notebookId)
          ? `Notebook ${named(names, 'notebook', args.notebookId)}`
          : 'The notebook',
      ],
    },
  }),

  onenote_create_page: (args, names) => ({
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
      location: [
        ...whose(args, names),
        ...(named(names, 'sectionNotebook', args.sectionId)
          ? [`Notebook ${named(names, 'sectionNotebook', args.sectionId)}`]
          : []),
        named(names, 'section', args.sectionId)
          ? `Section ${named(names, 'section', args.sectionId)}`
          : 'The section',
      ],
      bodyKey: 'markdown',
      body: text(args.markdown),
      bodyLabel: 'Page (Markdown)',
    },
  }),

  onenote_append_to_page: (args, names) => ({
    verb: 'Add',
    icon: 'doc',
    title: `Add to the ${text(args.position) === 'top' ? 'top' : 'end'} of ${
      named(names, 'page', args.pageId) ? `“${named(names, 'page', args.pageId)}”` : 'a page'
    }`,
    subtitle: ONENOTE,
    confirmLabel: 'Add to page',
    editable: [{ key: 'markdown', label: 'Addition', multiline: true }],
    body: {
      kind: 'document',
      mode: 'append',
      type: 'page',
      title: named(names, 'page', args.pageId) || 'The page',
      location: whose(args, names),
      bodyKey: 'markdown',
      body: text(args.markdown),
      bodyLabel: 'Added (Markdown)',
      unchanged: 'Everything already on the page stays as it is.',
    },
  }),

  onenote_delete_page: (args, names) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: named(names, 'page', args.pageId)
      ? `Delete the page “${named(names, 'page', args.pageId)}”`
      : 'Delete the page',
    subtitle: ONENOTE,
    confirmLabel: 'Delete page',
    body: {
      kind: 'document',
      mode: 'delete',
      type: 'page',
      title: named(names, 'page', args.pageId) || 'The page',
      location: whose(args, names),
      versionNote:
        'OneNote keeps deleted pages in the notebook’s recycle bin for a while; Renkei cannot restore them.',
    },
  }),
};
