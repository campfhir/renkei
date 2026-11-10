/** Preview cards for Confluence: pages, blog posts, comments, labels, spaces. */

import type { Names, PreviewBuilder, PreviewSpec } from './card';
import { named, nameOr, ref, text, yes } from './card';

const CONF = 'Confluence';
const CONTENT: Record<string, string> = { page: 'Page', blogpost: 'Blog post' };

/** “Title” when the lookup found it, else the generic phrase ("the page"). */
const called = (names: Names, kind: string, id: unknown, generic: string): string =>
  named(names, kind, id) ? `${generic} “${named(names, kind, id)}”` : generic;

const publishState = (status: string) => (status === 'draft' ? 'Draft' : 'Published');

function create(type: string, titleKey = 'title') {
  return (args: Record<string, unknown>, names: Names = {}): PreviewSpec => ({
    verb: 'Create',
    icon: 'doc',
    title: `Create the ${type.toLowerCase()} “${text(args.title)}”`,
    subtitle: CONF,
    confirmLabel: `Create ${type.toLowerCase()}`,
    editable: [
      { key: titleKey, label: 'Title', multiline: false },
      ...(args.markdown === undefined
        ? []
        : [{ key: 'markdown', label: 'Content', multiline: true }]),
    ],
    body: {
      kind: 'document',
      mode: 'create',
      type,
      titleKey,
      title: text(args.title),
      location: [
        named(names, 'space', args.spaceId)
          ? `Space ${named(names, 'space', args.spaceId)}`
          : 'In the chosen space',
        ...(text(args.parentId)
          ? [`Under ${called(names, 'page', args.parentId, 'a parent page')}`]
          : []),
      ],
      ...(type === 'Page' || type === 'Blog post'
        ? { status: publishState(text(args.status)) }
        : {}),
      ...(args.markdown === undefined ? {} : { bodyKey: 'markdown', body: text(args.markdown) }),
    },
  });
}

function remove(type: string, idKey: string, noun: string, kind: string) {
  return (args: Record<string, unknown>, names: Names): PreviewSpec => {
    const purge = yes(args.purge);
    return {
      verb: purge ? 'Delete forever' : 'Delete',
      tone: 'danger',
      icon: 'trash',
      title: `Delete ${called(names, kind, args[idKey], `the ${noun}`)}`,
      subtitle: CONF,
      confirmLabel: purge ? 'Delete permanently' : `Delete ${noun}`,
      body: {
        kind: 'document',
        mode: 'delete',
        type,
        title: nameOr(names, kind, args[idKey], `This ${noun}`),
        versionNote: purge
          ? 'Deleted permanently — it cannot be restored from the trash.'
          : 'Moved to the trash, where it can be restored.',
      },
    };
  };
}

export const CONFLUENCE_PREVIEWS: Record<string, PreviewBuilder> = {
  confluence_create_page: create('Page'),
  confluence_create_blogpost: create('Blog post'),
  confluence_create_database: (args, names) => create('Database')({ ...args }, names),
  confluence_create_whiteboard: (args, names) => create('Whiteboard')({ ...args }, names),

  confluence_update_page: (args, names) => ({
    verb: 'Edit',
    icon: 'doc',
    title: `Edit ${called(names, 'page', args.pageId, 'the page')}${text(args.title) ? ` — new title “${text(args.title)}”` : ''}`,
    subtitle: CONF,
    confirmLabel: 'Save page',
    editable: [
      ...(text(args.title) ? [{ key: 'title', label: 'Title', multiline: false }] : []),
      { key: 'markdown', label: 'New content', multiline: true },
    ],
    body: {
      kind: 'document',
      mode: 'update',
      type: 'Page',
      ...(text(args.title) ? { titleKey: 'title', title: text(args.title) } : {}),
      location: [nameOr(names, 'page', args.pageId, 'The page')],
      bodyKey: 'markdown',
      body: text(args.markdown),
      bodyLabel: 'The page will read',
      ...(text(args.versionMessage) ? { versionNote: text(args.versionMessage) } : {}),
      ...(text(args.title) ? {} : { unchanged: 'The title stays as it is.' }),
    },
  }),

  confluence_update_blogpost: (args, names) => ({
    verb: 'Edit',
    icon: 'doc',
    title: `Edit ${called(names, 'blogpost', args.blogpostId, 'the blog post')}${text(args.title) ? ` — new title “${text(args.title)}”` : ''}`,
    subtitle: CONF,
    confirmLabel: 'Save blog post',
    editable: [
      ...(text(args.title) ? [{ key: 'title', label: 'Title', multiline: false }] : []),
      { key: 'markdown', label: 'New content', multiline: true },
    ],
    body: {
      kind: 'document',
      mode: 'update',
      type: 'Blog post',
      ...(text(args.title) ? { titleKey: 'title', title: text(args.title) } : {}),
      location: [nameOr(names, 'blogpost', args.blogpostId, 'The blog post')],
      bodyKey: 'markdown',
      body: text(args.markdown),
      bodyLabel: 'The post will read',
      ...(text(args.title) ? {} : { unchanged: 'The title stays as it is.' }),
    },
  }),

  confluence_update_page_title: (args, names) => ({
    verb: 'Rename',
    icon: 'doc',
    title: `Rename ${called(names, 'page', args.pageId, 'the page')}`,
    subtitle: CONF,
    confirmLabel: 'Rename page',
    editable: [{ key: 'title', label: 'New title', multiline: false }],
    body: {
      kind: 'fileop',
      mode: 'rename',
      items: [{ name: nameOr(names, 'page', args.pageId, 'The page'), type: 'file' }],
      to: { name: text(args.title) },
      note: 'Links to the page keep working; only its title changes.',
    },
  }),

  confluence_move_page: (args, names) => ({
    verb: 'Move',
    icon: 'folder',
    title: `Move ${called(names, 'page', args.pageId, 'the page')}`,
    subtitle: CONF,
    confirmLabel: 'Move page',
    body: {
      kind: 'fileop',
      mode: 'move',
      items: [{ name: nameOr(names, 'page', args.pageId, 'The page'), type: 'file' }],
      to: { path: `Under ${called(names, 'page', args.newParentId, 'another page')}` },
      note: 'Its child pages move with it.',
    },
  }),

  confluence_delete_page: remove('Page', 'pageId', 'page', 'page'),
  confluence_delete_blogpost: remove('Blog post', 'blogpostId', 'blog post', 'blogpost'),
  confluence_delete_database: remove('Database', 'databaseId', 'database', 'database'),
  confluence_delete_whiteboard: remove('Whiteboard', 'whiteboardId', 'whiteboard', 'whiteboard'),

  confluence_set_page_status: (args, names) => ({
    verb: 'Set status',
    tone: text(args.status) === 'trashed' ? 'danger' : 'neutral',
    icon: 'flag',
    title: `Set ${called(names, 'page', args.pageId, 'the page')} to ${text(args.status)}`,
    subtitle: CONF,
    confirmLabel: 'Set status',
    body: {
      kind: 'transition',
      subject: ref(nameOr(names, 'page', args.pageId, 'The page'), 'Page'),
      field: 'Page status',
      to: text(args.status),
    },
  }),

  confluence_update_task_status: (args, names) => ({
    verb: text(args.status) === 'complete' ? 'Complete' : 'Reopen',
    tone: text(args.status) === 'complete' ? 'positive' : 'neutral',
    icon: 'check',
    title: `${text(args.status) === 'complete' ? 'Complete' : 'Reopen'} ${taskName(names, args.taskId)}`,
    subtitle: CONF,
    confirmLabel: text(args.status) === 'complete' ? 'Mark complete' : 'Reopen task',
    body: {
      kind: 'transition',
      subject: ref(taskName(names, args.taskId, true), 'Task'),
      field: 'Task',
      to: text(args.status) === 'complete' ? 'Done' : 'To do',
    },
  }),

  confluence_set_page_property: (args, names) => ({
    verb: 'Set',
    icon: 'tag',
    title: `Set a property on ${called(names, 'page', args.pageId, 'the page')}`,
    subtitle: CONF,
    confirmLabel: 'Set property',
    body: {
      kind: 'change',
      subject: ref(nameOr(names, 'page', args.pageId, 'The page'), 'Page'),
      rows: [
        { label: text(args.key), value: text(args.value), block: text(args.value).length > 80 },
      ],
    },
  }),

  confluence_add_label: (args, names) => ({
    verb: 'Label',
    icon: 'tag',
    title: `Add the label “${text(args.label)}”`,
    subtitle: CONF,
    confirmLabel: 'Add label',
    body: {
      kind: 'change',
      subject: ref(nameOr(names, 'content', args.contentId, 'The content'), 'Content'),
      rows: [{ label: 'Labels', add: [text(args.label)] }],
    },
  }),

  confluence_remove_label: (args, names) => ({
    verb: 'Unlabel',
    icon: 'tag',
    title: `Remove the label “${text(args.label)}”`,
    subtitle: CONF,
    confirmLabel: 'Remove label',
    body: {
      kind: 'change',
      subject: ref(nameOr(names, 'content', args.contentId, 'The content'), 'Content'),
      rows: [{ label: 'Labels', remove: [text(args.label)] }],
    },
  }),

  confluence_add_comment: (args, names) => {
    const inline = text(args.kind) === 'inline';
    const reply = Boolean(text(args.parentCommentId));
    const noun = CONTENT[text(args.contentType)]?.toLowerCase() ?? 'content';
    const onKind = text(args.contentType) === 'blogpost' ? 'blogpost' : 'page';
    return {
      verb: reply ? 'Reply' : 'Comment',
      icon: 'comment',
      title: `${reply ? 'Reply on' : 'Comment on'} ${called(names, onKind, args.contentId, `the ${noun}`)}`,
      subtitle: CONF,
      confirmLabel: 'Post comment',
      editable: [{ key: 'markdown', label: 'Comment', multiline: true }],
      body: {
        kind: 'comment',
        mode: 'add',
        on: ref(
          nameOr(names, onKind, args.contentId, `The ${noun}`),
          CONTENT[text(args.contentType)] ?? 'Content'
        ),
        bodyKey: 'markdown',
        body: text(args.markdown),
        badges: [inline ? 'Inline comment' : 'Page comment', ...(reply ? ['Reply'] : [])],
        ...(inline && text(args.inlineAnchorText)
          ? { anchor: { text: text(args.inlineAnchorText) } }
          : {}),
      },
    };
  },

  confluence_update_comment: (args, names) => ({
    verb: 'Edit',
    icon: 'comment',
    title: named(names, 'comment', args.commentId)
      ? `Edit the comment ${named(names, 'comment', args.commentId)}`
      : 'Edit a comment',
    subtitle: CONF,
    confirmLabel: 'Save comment',
    editable: [{ key: 'markdown', label: 'Comment', multiline: true }],
    body: {
      kind: 'comment',
      mode: 'edit',
      on: ref(
        nameOr(names, 'comment', args.commentId, 'The comment'),
        text(args.kind) === 'inline' ? 'Inline comment' : 'Comment'
      ),
      commentId: text(args.commentId),
      commentLabel: named(names, 'comment', args.commentId),
      bodyKey: 'markdown',
      body: text(args.markdown),
    },
  }),

  confluence_delete_comment: (args, names) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: named(names, 'comment', args.commentId)
      ? `Delete the comment ${named(names, 'comment', args.commentId)}`
      : 'Delete a comment',
    subtitle: CONF,
    confirmLabel: 'Delete comment',
    body: {
      kind: 'comment',
      mode: 'delete',
      on: ref(
        nameOr(names, 'comment', args.commentId, 'The comment'),
        text(args.kind) === 'inline' ? 'Inline comment' : 'Comment'
      ),
      commentId: text(args.commentId),
      commentLabel: named(names, 'comment', args.commentId),
    },
  }),

  confluence_delete_attachment: (args, names) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: `Delete ${called(names, 'attachment', args.attachmentId, 'the attachment')}`,
    subtitle: CONF,
    confirmLabel: 'Delete attachment',
    body: {
      kind: 'fileop',
      mode: 'delete',
      items: [
        {
          name: nameOr(names, 'attachment', args.attachmentId, 'The attachment'),
          type: 'attachment',
        },
      ],
      note: 'Pages that embed it show a broken file.',
    },
  }),

  confluence_watch_space: (args) => watch(args, true),
  confluence_unwatch_space: (args) => watch(args, false),
};

/** "the task on “Page”" when the page is known; "a task" otherwise. */
function taskName(names: Names, id: unknown, capital = false): string {
  const page = named(names, 'task', id);
  if (page) return `${capital ? 'The' : 'the'} task on “${page}”`;
  return capital ? 'The task' : 'a task';
}

function watch(args: Record<string, unknown>, on: boolean): PreviewSpec {
  return {
    verb: on ? 'Watch' : 'Unwatch',
    icon: 'bell',
    title: `${on ? 'Watch' : 'Stop watching'} the ${text(args.space)} space`,
    subtitle: CONF,
    confirmLabel: on ? 'Watch space' : 'Stop watching',
    body: {
      kind: 'access',
      mode: on ? 'watch' : 'unwatch',
      who: [],
      on: ref(text(args.space), 'Space'),
      details: [
        {
          label: 'You will',
          value: on ? 'be notified of new and changed pages' : 'stop being notified of changes',
        },
      ],
    },
  };
}
