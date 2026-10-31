/**
 * The names behind the ids a Confluence act's preview card carries (see
 * ../lookup.ts): the page being edited, the space it is created in, the
 * comment being deleted. Each lookup only reads; a failure just leaves the
 * name out and the card says "the page" rather than an id.
 */

import type { MCPToolContext } from '../common';
import { registerPreviewLookups } from '../lookup';
import { nameKey, text, type Args, type Names } from '../previews/card';
import { confluenceGet, rec, str } from './client';
import type { ConfluenceAuth } from './confluence-auth';

const EXCERPT = 80;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
};

/**
 * Plain text of Confluence storage/ADF-less HTML: tags dropped, whitespace
 * folded. Entities are decoded in ONE pass, so "&amp;lt;" reads "&lt;" and
 * not "<" (chained replaces would unescape it twice).
 */
export function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

const CONTENT_PATH: Record<string, string> = {
  page: 'pages',
  blogpost: 'blogposts',
  database: 'databases',
  whiteboard: 'whiteboards',
  attachment: 'attachments',
};

export function registerConfluencePreviewLookups(
  context: MCPToolContext,
  auth: ConfluenceAuth
): void {
  const get = async (path: string): Promise<Args | null> => {
    try {
      const access = await auth.resolve();
      if (typeof access === 'string') return null;
      const result = await confluenceGet(context, access, path);
      return result.ok ? result.body : null;
    } catch {
      return null;
    }
  };
  const id = (value: unknown) => encodeURIComponent(text(value));

  /** { kind:id → title } for a page, blog post, database, whiteboard or attachment. */
  const titled = async (kind: string, value: unknown): Promise<Names> => {
    if (!text(value) || !CONTENT_PATH[kind]) return {};
    const found = await get(`/api/v2/${CONTENT_PATH[kind]}/${id(value)}`);
    return str(found?.title) ? { [nameKey(kind, text(value))]: str(found?.title) } : {};
  };

  const space = async (value: unknown): Promise<Names> => {
    if (!text(value)) return {};
    const found = await get(`/api/v2/spaces/${id(value)}`);
    return str(found?.name) ? { [nameKey('space', text(value))]: str(found?.name) } : {};
  };

  /** Any content id (page, blog post or attachment) through the one v1 route that takes all. */
  const content = async (value: unknown): Promise<Names> => {
    if (!text(value)) return {};
    const found = await get(`/rest/api/content/${id(value)}`);
    return str(found?.title) ? { [nameKey('content', text(value))]: str(found?.title) } : {};
  };

  const merge = async (...parts: Promise<Names>[]): Promise<Names> =>
    Object.assign({}, ...(await Promise.all(parts)));

  const create = async (args: Args): Promise<Names> =>
    merge(space(args.spaceId), titled('page', args.parentId));

  const comment = async (args: Args): Promise<Names> => {
    const path = text(args.kind) === 'inline' ? 'inline-comments' : 'footer-comments';
    const found = await get(`/api/v2/${path}/${id(args.commentId)}?body-format=storage`);
    if (!found) return {};
    const excerpt = plain(str(rec(rec(found.body).storage).value));
    const label = excerpt.length > EXCERPT ? `${excerpt.slice(0, EXCERPT)}…` : excerpt;
    return label ? { [nameKey('comment', text(args.commentId))]: `“${label}”` } : {};
  };

  registerPreviewLookups(context, {
    confluence_create_page: create,
    confluence_create_blogpost: (args) => space(args.spaceId),
    confluence_create_database: create,
    confluence_create_whiteboard: create,

    confluence_update_page: (args) => titled('page', args.pageId),
    confluence_update_page_title: (args) => titled('page', args.pageId),
    confluence_move_page: (args) =>
      merge(titled('page', args.pageId), titled('page', args.newParentId)),
    confluence_delete_page: (args) => titled('page', args.pageId),
    confluence_set_page_status: (args) => titled('page', args.pageId),
    confluence_set_page_property: (args) => titled('page', args.pageId),
    confluence_update_blogpost: (args) => titled('blogpost', args.blogpostId),
    confluence_delete_blogpost: (args) => titled('blogpost', args.blogpostId),
    confluence_delete_database: (args) => titled('database', args.databaseId),
    confluence_delete_whiteboard: (args) => titled('whiteboard', args.whiteboardId),
    confluence_delete_attachment: (args) => titled('attachment', args.attachmentId),

    // A task has no title of its own: the page it sits on is what a person recognises.
    confluence_update_task_status: async (args) => {
      const task = await get(`/api/v2/tasks/${id(args.taskId)}`);
      const pageId = str(task?.pageId);
      const blogId = str(task?.blogPostId);
      const where = pageId
        ? (await titled('page', pageId))[nameKey('page', pageId)]
        : blogId
          ? (await titled('blogpost', blogId))[nameKey('blogpost', blogId)]
          : '';
      return where ? { [nameKey('task', text(args.taskId))]: where } : {};
    },

    confluence_add_label: (args) => content(args.contentId),
    confluence_remove_label: (args) => content(args.contentId),

    confluence_add_comment: (args) =>
      titled(text(args.contentType) === 'blogpost' ? 'blogpost' : 'page', args.contentId),
    confluence_update_comment: comment,
    confluence_delete_comment: comment,
  });
}
