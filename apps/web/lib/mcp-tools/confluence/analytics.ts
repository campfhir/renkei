/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Confluence has no space-level analytics API at all (confirmed via
 * research, not assumed) — only this v1, per-page view/viewer count
 * endpoint. "Analytics of a space" in practice means calling this once
 * per page and aggregating client-side; the tool description says so
 * rather than implying a space-wide rollup that doesn't exist.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { confluenceGet, textResult, errText, str } from './client';
import type { MCPToolContext } from '../common';
import type { ConfluenceAuth } from './confluence-auth';

export async function registerAnalyticsTools(
  server: McpServer,
  context: MCPToolContext,
  auth: ConfluenceAuth
): Promise<void> {
  server.registerTool(
    'confluence_get_page_analytics',
    {
      title: 'Confluence · Read — Get a page’s view analytics',
      description:
        'Total view count and distinct viewer count for one page or blog post. There is no ' +
        'space-level analytics API — to approximate "analytics for a space," call this once per ' +
        'page (from confluence_list_pages) and add the counts up yourself. May require a ' +
        'Premium/Enterprise Confluence plan; if it 403s or 404s on a Standard site, that’s why.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        contentId: z.string().min(1).describe('Page or blog post id'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const contentId = str(args.contentId);
      if (!contentId) return errText('contentId is required');

      const [views, viewers] = await Promise.all([
        confluenceGet(
          context,
          access,
          `/rest/api/analytics/content/${encodeURIComponent(contentId)}/views`
        ),
        confluenceGet(
          context,
          access,
          `/rest/api/analytics/content/${encodeURIComponent(contentId)}/viewers`
        ),
      ]);
      if (!views.ok) return errText(views.error);
      const viewCount = typeof views.body.count === 'number' ? views.body.count : 0;
      const viewerCount =
        viewers.ok && typeof viewers.body.count === 'number' ? viewers.body.count : 'unavailable';
      return textResult(`Views: ${viewCount}\nDistinct viewers: ${viewerCount}`);
    }
  );
}
