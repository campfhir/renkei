/**
 * The names behind the ids a SharePoint act's preview card carries (see
 * ../lookup.ts): the site, and a page's title. Reads only; a failure leaves
 * the name out and the card says "the page".
 */

import type { MCPToolContext } from '../common';
import { registerDocumentPreviewLookups, enc, withReader } from '../graph/preview-lookups';
import type { GraphAuth } from '../graph/graph-auth';
import { registerPreviewLookups } from '../lookup';
import { nameKey, record, text } from '../previews/card';

const PAGE_CAST = 'microsoft.graph.sitePage';

export function registerSharePointPreviewLookups(context: MCPToolContext, auth: GraphAuth): void {
  registerDocumentPreviewLookups(context, auth, 'sharepoint');

  const pages = withReader(context, auth, async (read, args) => {
    const site = text(args.site);
    const names: Record<string, string> = {};
    const found = site ? await read.site(site) : null;
    if (found?.name) names[nameKey('site', site)] = found.name;
    const pageId = text(args.pageId);
    if (pageId && found) {
      const pageRead = await read.get(
        `/sites/${found.id}/pages/${enc(pageId)}/${PAGE_CAST}?$select=title,name`
      );
      const title = text(pageRead?.title) || text(pageRead?.name);
      if (title) names[nameKey('page', pageId)] = title;
    }
    return names;
  });

  // A list item's card: the site, the list's title (from its id or URL) and
  // the item's own Title, so a delete says what it deletes.
  const listItems = withReader(context, auth, async (read, args) => {
    const list = text(args.list);
    const site = text(args.site) || (list.startsWith('https://') ? list : '');
    const names: Record<string, string> = {};
    const found = site ? await read.site(site) : null;
    if (!found) return names;
    if (text(args.site)) names[nameKey('site', text(args.site))] = found.name;
    let listId = list;
    if (list.startsWith('https://') || /^[0-9a-f-]{36}$/i.test(list)) {
      const lists = await read.get(`/sites/${found.id}/lists?$select=id,displayName,webUrl`);
      const entries = Array.isArray(lists?.value) ? lists.value.map(record) : [];
      const match = entries.find(
        (entry) =>
          text(entry.id).toLowerCase() === list.toLowerCase() ||
          (list.startsWith('https://') &&
            text(entry.webUrl) !== '' &&
            decodeURIComponent(list)
              .toLowerCase()
              .startsWith(decodeURIComponent(text(entry.webUrl)).toLowerCase()))
      );
      if (match) {
        listId = text(match.id);
        if (text(match.displayName)) names[nameKey('list', list)] = text(match.displayName);
      }
    }
    const itemId = text(args.itemId);
    if (itemId && listId && !listId.startsWith('https://')) {
      const item = await read.get(
        `/sites/${found.id}/lists/${enc(listId)}/items/${enc(itemId)}?$expand=fields($select=Title)`
      );
      const title = text(record(item?.fields).Title);
      if (title) names[nameKey('listItem', itemId)] = title;
    }
    return names;
  });

  registerPreviewLookups(context, {
    sharepoint_create_list_item: listItems,
    sharepoint_update_list_item: listItems,
    sharepoint_delete_list_item: listItems,
    sharepoint_create_page: pages,
    sharepoint_update_page: pages,
    sharepoint_publish_page: pages,
    sharepoint_delete_page: pages,
  });
}
