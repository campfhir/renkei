/** Preview cards for Confluence: pages, blog posts, comments, labels, spaces. */

import type { PreviewBuilder, PreviewSpec } from './card';
import { ref, text, yes } from './card';

const CONF = 'Confluence';
const CONTENT: Record<string, string> = { page: 'Page', blogpost: 'Blog post' };

const publishState = (status: string) => (status === 'draft' ? 'Draft' : 'Published');

function create(type: string, titleKey = 'title') {
  return (args: Record<string, unknown>): PreviewSpec => ({
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
        `Space ${text(args.spaceId)}`,
        ...(text(args.parentId) ? [`Under page ${text(args.parentId)}`] : []),
      ],
      ...(type === 'Page' || type === 'Blog post'
        ? { status: publishState(text(args.status)) }
        : {}),
      ...(args.markdown === undefined ? {} : { bodyKey: 'markdown', body: text(args.markdown) }),
    },
  });
}

function remove(type: string, idKey: string, noun: string) {
  return (args: Record<string, unknown>): PreviewSpec => {
    const purge = yes(args.purge);
    return {
      verb: purge ? 'Delete forever' : 'Delete',
      tone: 'danger',
      icon: 'trash',
      title: `Delete ${noun} ${text(args[idKey])}`,
      subtitle: CONF,
      confirmLabel: purge ? 'Delete permanently' : `Delete ${noun}`,
      body: {
        kind: 'document',
        mode: 'delete',
        type,
        title: `${type} ${text(args[idKey])}`,
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
  confluence_create_database: (args) => create('Database')({ ...args }),
  confluence_create_whiteboard: (args) => create('Whiteboard')({ ...args }),

  confluence_update_page: (args) => ({
    verb: 'Edit',
    icon: 'doc',
    title: `Edit page ${text(args.pageId)}${text(args.title) ? ` — “${text(args.title)}”` : ''}`,
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
      location: [`Page ${text(args.pageId)}`],
      bodyKey: 'markdown',
      body: text(args.markdown),
      bodyLabel: 'The page will read',
      ...(text(args.versionMessage) ? { versionNote: text(args.versionMessage) } : {}),
      ...(text(args.title) ? {} : { unchanged: 'The title stays as it is.' }),
    },
  }),

  confluence_update_blogpost: (args) => ({
    verb: 'Edit',
    icon: 'doc',
    title: `Edit blog post ${text(args.blogpostId)}${text(args.title) ? ` — “${text(args.title)}”` : ''}`,
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
      location: [`Blog post ${text(args.blogpostId)}`],
      bodyKey: 'markdown',
      body: text(args.markdown),
      bodyLabel: 'The post will read',
      ...(text(args.title) ? {} : { unchanged: 'The title stays as it is.' }),
    },
  }),

  confluence_update_page_title: (args) => ({
    verb: 'Rename',
    icon: 'doc',
    title: `Rename page ${text(args.pageId)}`,
    subtitle: CONF,
    confirmLabel: 'Rename page',
    editable: [{ key: 'title', label: 'New title', multiline: false }],
    body: {
      kind: 'fileop',
      mode: 'rename',
      items: [{ name: `Page ${text(args.pageId)}`, type: 'file' }],
      to: { name: text(args.title) },
      note: 'Links to the page keep working; only its title changes.',
    },
  }),

  confluence_move_page: (args) => ({
    verb: 'Move',
    icon: 'folder',
    title: `Move page ${text(args.pageId)}`,
    subtitle: CONF,
    confirmLabel: 'Move page',
    body: {
      kind: 'fileop',
      mode: 'move',
      items: [{ name: `Page ${text(args.pageId)}`, type: 'file' }],
      to: { path: `Under page ${text(args.newParentId)}` },
      note: 'Its child pages move with it.',
    },
  }),

  confluence_delete_page: remove('Page', 'pageId', 'page'),
  confluence_delete_blogpost: remove('Blog post', 'blogpostId', 'blog post'),
  confluence_delete_database: remove('Database', 'databaseId', 'database'),
  confluence_delete_whiteboard: remove('Whiteboard', 'whiteboardId', 'whiteboard'),

  confluence_set_page_status: (args) => ({
    verb: 'Set status',
    tone: text(args.status) === 'trashed' ? 'danger' : 'neutral',
    icon: 'flag',
    title: `Set page ${text(args.pageId)} to ${text(args.status)}`,
    subtitle: CONF,
    confirmLabel: 'Set status',
    body: {
      kind: 'transition',
      subject: ref(text(args.pageId), 'Page'),
      field: 'Page status',
      to: text(args.status),
    },
  }),

  confluence_update_task_status: (args) => ({
    verb: text(args.status) === 'complete' ? 'Complete' : 'Reopen',
    tone: text(args.status) === 'complete' ? 'positive' : 'neutral',
    icon: 'check',
    title: `${text(args.status) === 'complete' ? 'Complete' : 'Reopen'} task ${text(args.taskId)}`,
    subtitle: CONF,
    confirmLabel: text(args.status) === 'complete' ? 'Mark complete' : 'Reopen task',
    body: {
      kind: 'transition',
      subject: ref(text(args.taskId), 'Task'),
      field: 'Task',
      to: text(args.status) === 'complete' ? 'Done' : 'To do',
    },
  }),

  confluence_set_page_property: (args) => ({
    verb: 'Set',
    icon: 'tag',
    title: `Set a property on page ${text(args.pageId)}`,
    subtitle: CONF,
    confirmLabel: 'Set property',
    body: {
      kind: 'change',
      subject: ref(text(args.pageId), 'Page'),
      rows: [
        { label: text(args.key), value: text(args.value), block: text(args.value).length > 80 },
      ],
    },
  }),

  confluence_add_label: (args) => ({
    verb: 'Label',
    icon: 'tag',
    title: `Add the label “${text(args.label)}”`,
    subtitle: CONF,
    confirmLabel: 'Add label',
    body: {
      kind: 'change',
      subject: ref(text(args.contentId), 'Content'),
      rows: [{ label: 'Labels', add: [text(args.label)] }],
    },
  }),

  confluence_remove_label: (args) => ({
    verb: 'Unlabel',
    icon: 'tag',
    title: `Remove the label “${text(args.label)}”`,
    subtitle: CONF,
    confirmLabel: 'Remove label',
    body: {
      kind: 'change',
      subject: ref(text(args.contentId), 'Content'),
      rows: [{ label: 'Labels', remove: [text(args.label)] }],
    },
  }),

  confluence_add_comment: (args) => {
    const inline = text(args.kind) === 'inline';
    const reply = Boolean(text(args.parentCommentId));
    return {
      verb: reply ? 'Reply' : 'Comment',
      icon: 'comment',
      title: `${reply ? 'Reply on' : 'Comment on'} ${CONTENT[text(args.contentType)]?.toLowerCase() ?? 'content'} ${text(args.contentId)}`,
      subtitle: CONF,
      confirmLabel: 'Post comment',
      editable: [{ key: 'markdown', label: 'Comment', multiline: true }],
      body: {
        kind: 'comment',
        mode: 'add',
        on: ref(text(args.contentId), CONTENT[text(args.contentType)] ?? 'Content'),
        bodyKey: 'markdown',
        body: text(args.markdown),
        badges: [inline ? 'Inline comment' : 'Page comment', ...(reply ? ['Reply'] : [])],
        ...(inline && text(args.inlineAnchorText)
          ? { anchor: { text: text(args.inlineAnchorText) } }
          : {}),
      },
    };
  },

  confluence_update_comment: (args) => ({
    verb: 'Edit',
    icon: 'comment',
    title: `Edit comment ${text(args.commentId)}`,
    subtitle: CONF,
    confirmLabel: 'Save comment',
    editable: [{ key: 'markdown', label: 'Comment', multiline: true }],
    body: {
      kind: 'comment',
      mode: 'edit',
      on: ref(text(args.commentId), text(args.kind) === 'inline' ? 'Inline comment' : 'Comment'),
      commentId: text(args.commentId),
      bodyKey: 'markdown',
      body: text(args.markdown),
    },
  }),

  confluence_delete_comment: (args) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: `Delete comment ${text(args.commentId)}`,
    subtitle: CONF,
    confirmLabel: 'Delete comment',
    body: {
      kind: 'comment',
      mode: 'delete',
      on: ref(text(args.commentId), text(args.kind) === 'inline' ? 'Inline comment' : 'Comment'),
      commentId: text(args.commentId),
    },
  }),

  confluence_delete_attachment: (args) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: `Delete attachment ${text(args.attachmentId)}`,
    subtitle: CONF,
    confirmLabel: 'Delete attachment',
    body: {
      kind: 'fileop',
      mode: 'delete',
      items: [{ name: `Attachment ${text(args.attachmentId)}`, type: 'attachment' }],
      note: 'Pages that embed it show a broken file.',
    },
  }),

  confluence_watch_space: (args) => watch(args, true),
  confluence_unwatch_space: (args) => watch(args, false),
};

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
