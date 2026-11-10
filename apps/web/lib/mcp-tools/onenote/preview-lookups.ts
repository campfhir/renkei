/**
 * The names behind the ids a OneNote act's preview card carries (see
 * ../lookup.ts): the notebook, section, page, and the site or group whose
 * notebooks they are. Reads only; a failure leaves the name out and the card
 * says "the notebook".
 */

import type { MCPToolContext } from '../common';
import type { GraphAuth } from '../graph/graph-auth';
import { enc, withReader } from '../graph/preview-lookups';
import { registerPreviewLookups } from '../lookup';
import { nameKey, record, text } from '../previews/card';

export function registerOneNotePreviewLookups(context: MCPToolContext, auth: GraphAuth): void {
  const onenote = withReader(context, auth, async (read, args) => {
    const names: Record<string, string> = {};
    const site = text(args.site);
    const groupId = text(args.groupId);

    // Whose notebooks: the same root the tools themselves resolve.
    let root = '/me/onenote';
    if (site) {
      const found = await read.site(site);
      if (found?.name) names[nameKey('site', site)] = found.name;
      root = found ? `/sites/${enc(found.id)}/onenote` : '';
    } else if (groupId) {
      root = `/groups/${enc(groupId)}/onenote`;
      const group = await read.get(`/groups/${enc(groupId)}?$select=displayName`);
      if (text(group?.displayName)) names[nameKey('group', groupId)] = text(group?.displayName);
    }
    if (!root) return names;

    const notebookId = text(args.notebookId);
    const sectionId = text(args.sectionId);
    const pageId = text(args.pageId);
    const [notebook, section, page] = await Promise.all([
      notebookId
        ? read.get(`${root}/notebooks/${enc(notebookId)}?$select=displayName`)
        : Promise.resolve(null),
      sectionId
        ? read.get(
            `${root}/sections/${enc(sectionId)}?$select=displayName&$expand=parentNotebook($select=displayName)`
          )
        : Promise.resolve(null),
      pageId ? read.get(`${root}/pages/${enc(pageId)}?$select=title`) : Promise.resolve(null),
    ]);
    if (text(notebook?.displayName)) {
      names[nameKey('notebook', notebookId)] = text(notebook?.displayName);
    }
    if (text(section?.displayName)) {
      names[nameKey('section', sectionId)] = text(section?.displayName);
      const parent = text(record(section?.parentNotebook).displayName);
      if (parent) names[nameKey('sectionNotebook', sectionId)] = parent;
    }
    if (text(page?.title)) names[nameKey('page', pageId)] = text(page?.title);
    return names;
  });

  registerPreviewLookups(context, {
    onenote_create_section: onenote,
    onenote_create_page: onenote,
    onenote_append_to_page: onenote,
    onenote_delete_page: onenote,
  });
}
