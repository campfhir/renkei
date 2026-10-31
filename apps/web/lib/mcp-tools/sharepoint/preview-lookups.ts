/**
 * The names behind the ids a SharePoint act's preview card carries (see
 * ../lookup.ts): the site, and a page's title. Reads only; a failure leaves
 * the name out and the card says "the page".
 */

import type { MCPToolContext } from '../common';
import { registerDocumentPreviewLookups, enc, withReader } from '../graph/preview-lookups';
import type { GraphAuth } from '../graph/graph-auth';
import { registerPreviewLookups } from '../lookup';
import { nameKey, text } from '../previews/card';

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

  registerPreviewLookups(context, {
    sharepoint_create_page: pages,
    sharepoint_update_page: pages,
    sharepoint_publish_page: pages,
    sharepoint_delete_page: pages,
  });
}
