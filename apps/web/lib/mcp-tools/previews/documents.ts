/**
 * Preview cards for documents and files: OneDrive and SharePoint libraries
 * and pages (one family, registered under both prefixes) and file shares.
 */

import type { FileItem } from '@/lib/mcp-widgets/src/act-card';
import type { PreviewBuilder, PreviewSpec } from './card';
import { clip, people, record, ref, show, strings, text, yes } from './card';

type Args = Record<string, unknown>;

interface Service {
  prefix: 'onedrive' | 'sharepoint';
  name: 'OneDrive' | 'SharePoint';
}

const SERVICES: Service[] = [
  { prefix: 'onedrive', name: 'OneDrive' },
  { prefix: 'sharepoint', name: 'SharePoint' },
];

/** The file or folder a call names, the way a person would: by its path, else its link. */
function itemOf(args: Args): { item: FileItem; where: string } {
  const path = text(args.path).replace(/^\/+/, '');
  const url = text(args.itemUrl);
  const fromUrl = (() => {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    } catch {
      return '';
    }
  })();
  const name = path ? (path.split('/').pop() ?? path) : fromUrl || 'The item you named';
  const where = [text(args.site), text(args.library)].filter(Boolean).join(' · ');
  return {
    item: {
      name,
      type: 'file',
      ...(path.includes('/')
        ? { path: `/${path.split('/').slice(0, -1).join('/')}` }
        : where
          ? { path: where }
          : {}),
    },
    where,
  };
}

const CONFLICT: Record<string, string> = {
  rename: 'If the name is taken, the new one is renamed.',
  replace: 'If the name is taken, the existing one is replaced.',
  fail: 'If the name is taken, nothing is created.',
};

function family(service: Service): Record<string, PreviewBuilder> {
  const { prefix, name: system } = service;
  const sub = (args: Args) => [system, text(args.site)].filter(Boolean).join(' · ');
  const builders: Record<string, PreviewBuilder> = {
    [`${prefix}_create_folder`]: (args): PreviewSpec => {
      const parent = itemOf(args);
      return {
        verb: 'Create',
        icon: 'folder',
        title: `Create the folder ${text(args.name)}`,
        subtitle: sub(args),
        confirmLabel: 'Create folder',
        body: {
          kind: 'fileop',
          mode: 'create',
          items: [{ name: text(args.name), type: 'folder' }],
          to: {
            path: text(args.path)
              ? `/${text(args.path).replace(/^\/+/, '')}`
              : parent.where || 'The root',
          },
          note: CONFLICT[text(args.ifNameTaken) || 'rename'],
        },
      };
    },
    [`${prefix}_copy_document`]: (args): PreviewSpec => {
      const { item } = itemOf(args);
      return {
        verb: 'Copy',
        icon: 'doc',
        title: `Copy ${item.name}`,
        subtitle: sub(args),
        confirmLabel: 'Copy',
        body: {
          kind: 'fileop',
          mode: 'copy',
          items: [item],
          to: {
            path: text(args.destinationFolderId)
              ? `Folder ${text(args.destinationFolderId)}`
              : 'The same folder',
            ...(text(args.newName) ? { name: text(args.newName) } : {}),
          },
          note: 'The original stays where it is.',
        },
      };
    },
    [`${prefix}_move_document`]: (args): PreviewSpec => {
      const { item } = itemOf(args);
      const destination =
        text(args.destinationPath) ||
        (text(args.destinationFolderId) ? `Folder ${text(args.destinationFolderId)}` : '');
      return {
        verb: 'Move',
        icon: 'folder',
        title: `Move ${item.name}`,
        subtitle: sub(args),
        confirmLabel: 'Move',
        body: {
          kind: 'fileop',
          mode: 'move',
          items: [item],
          to: {
            path: destination || 'The same folder',
            ...(text(args.newName) ? { name: text(args.newName) } : {}),
          },
          note: 'Links people already have keep working.',
        },
      };
    },
    [`${prefix}_rename_document`]: (args): PreviewSpec => {
      const { item } = itemOf(args);
      return {
        verb: 'Rename',
        icon: 'doc',
        title: `Rename ${item.name}`,
        subtitle: sub(args),
        confirmLabel: 'Rename',
        editable: [{ key: 'newName', label: 'New name', multiline: false }],
        body: { kind: 'fileop', mode: 'rename', items: [item], to: { name: text(args.newName) } },
      };
    },
    [`${prefix}_delete_document`]: (args): PreviewSpec => {
      const { item } = itemOf(args);
      return {
        verb: 'Delete',
        tone: 'danger',
        icon: 'trash',
        title: `Delete ${item.name}`,
        subtitle: sub(args),
        confirmLabel: 'Delete',
        body: {
          kind: 'fileop',
          mode: 'delete',
          items: [item],
          note: `It goes to the ${system} recycle bin; anyone with a link to it loses access.`,
        },
      };
    },
    [`${prefix}_share_document`]: (args): PreviewSpec => {
      const { item } = itemOf(args);
      const scope = text(args.scope) || 'organization';
      const edit = text(args.linkType) === 'edit';
      const anonymous = scope === 'anonymous';
      return {
        verb: 'Share',
        tone: anonymous ? 'danger' : 'caution',
        icon: 'link',
        title: `Create ${edit ? 'an editing' : 'a viewing'} link to ${item.name}`,
        subtitle: sub(args),
        confirmLabel: 'Create link',
        body: {
          kind: 'access',
          mode: 'share',
          who: [
            {
              name:
                scope === 'anonymous'
                  ? 'Anyone with the link'
                  : scope === 'users'
                    ? 'Only the people it is given to'
                    : 'Anyone in your organization',
              kind: 'group',
            },
          ],
          level: edit ? 'Can edit' : 'Can view',
          on: ref(item.name, 'File', item.path),
          details: [
            ...(text(args.expiresOn) ? [{ label: 'Expires', value: text(args.expiresOn) }] : []),
            ...(anonymous
              ? [
                  {
                    label: 'Note',
                    value: 'People outside the organization can open it without signing in.',
                  },
                ]
              : []),
          ],
        },
      };
    },
    [`${prefix}_add_user_to_document`]: (args): PreviewSpec => {
      const { item } = itemOf(args);
      const emails = strings(args.emails);
      return {
        verb: 'Share',
        tone: 'caution',
        icon: 'users',
        title: `Give ${emails.length === 1 ? emails[0] : `${emails.length} people`} access to ${item.name}`,
        subtitle: sub(args),
        confirmLabel: 'Share',
        editable:
          args.message === undefined ? [] : [{ key: 'message', label: 'Message', multiline: true }],
        body: {
          kind: 'access',
          mode: 'grant',
          who: people(emails, 'email'),
          level: text(args.role) === 'write' ? 'Can edit' : 'Can view',
          on: ref(item.name, 'File', item.path),
          details: [
            {
              label: 'Notification',
              value: args.notify === false ? 'They are not emailed' : 'They get an email',
            },
          ],
          bodyKey: 'message',
          body: text(args.message),
        },
      };
    },
    [`${prefix}_remove_user_from_document`]: (args): PreviewSpec => {
      const { item } = itemOf(args);
      const who = text(args.email) || `Permission ${text(args.permissionId)}`;
      return {
        verb: 'Unshare',
        tone: 'danger',
        icon: 'users',
        title: `Take ${who}’s access to ${item.name} away`,
        subtitle: sub(args),
        confirmLabel: 'Remove access',
        body: {
          kind: 'access',
          mode: 'revoke',
          who: [{ name: who, kind: 'email' }],
          on: ref(item.name, 'File', item.path),
        },
      };
    },
  };
  if (prefix === 'sharepoint') {
    Object.assign(builders, {
      sharepoint_create_page: (args: Args): PreviewSpec => ({
        verb: 'Create',
        icon: 'doc',
        title: `Create the page “${text(args.title)}”`,
        subtitle: sub(args),
        confirmLabel: yes(args.publish) ? 'Create and publish' : 'Create page',
        editable: [{ key: 'title', label: 'Title', multiline: false }],
        body: {
          kind: 'document',
          mode: 'create',
          type: 'Site page',
          titleKey: 'title',
          title: text(args.title),
          location: [text(args.site)],
          status: yes(args.publish) ? 'Published' : 'Draft',
          ...(args.contentHtml === undefined ? {} : { body: htmlText(text(args.contentHtml)) }),
        },
      }),
      sharepoint_update_page: (args: Args): PreviewSpec => ({
        verb: 'Edit',
        icon: 'doc',
        title: text(args.title)
          ? `Edit the page “${text(args.title)}”`
          : `Edit page ${text(args.pageId)}`,
        subtitle: sub(args),
        confirmLabel: yes(args.publish) ? 'Save and publish' : 'Save page',
        body: {
          kind: 'document',
          mode: 'update',
          type: 'Site page',
          ...(text(args.title) ? { title: text(args.title) } : {}),
          location: [text(args.site), `Page ${text(args.pageId)}`],
          status: yes(args.publish) ? 'Published after saving' : undefined,
          ...(args.contentHtml === undefined
            ? { unchanged: 'The page content stays as it is.' }
            : { body: htmlText(text(args.contentHtml)), bodyLabel: 'The page will read' }),
        },
      }),
      sharepoint_publish_page: (args: Args): PreviewSpec => ({
        verb: 'Publish',
        tone: 'caution',
        icon: 'upload',
        title: `Publish page ${text(args.pageId)}`,
        subtitle: sub(args),
        confirmLabel: 'Publish page',
        body: {
          kind: 'document',
          mode: 'publish',
          type: 'Site page',
          title: `Page ${text(args.pageId)}`,
          location: [text(args.site)],
          status: 'Published',
          versionNote: 'Everyone who can see the site can read it.',
        },
      }),
      sharepoint_delete_page: (args: Args): PreviewSpec => ({
        verb: 'Delete',
        tone: 'danger',
        icon: 'trash',
        title: `Delete page ${text(args.pageId)}`,
        subtitle: sub(args),
        confirmLabel: 'Delete page',
        body: {
          kind: 'document',
          mode: 'delete',
          type: 'Site page',
          title: `Page ${text(args.pageId)}`,
          location: [text(args.site)],
        },
      }),
      sharepoint_update_document_metadata: (args: Args): PreviewSpec => {
        const { item } = itemOf(args);
        return {
          verb: 'Update',
          icon: 'tag',
          title: `Update the properties of ${item.name}`,
          subtitle: sub(args),
          confirmLabel: 'Update properties',
          body: {
            kind: 'change',
            subject: ref(item.name, 'File', item.path),
            rows: Object.entries(record(args.fields)).map(([label, value]) => ({
              label,
              value: show(value),
            })),
          },
        };
      },
      sharepoint_watch_library: (args: Args) => watch(args, true, sub(args)),
      sharepoint_unwatch_library: (args: Args) => watch(args, false, sub(args)),
    });
  }
  return builders;
}

function watch(args: Args, on: boolean, subtitle: string): PreviewSpec {
  const library = text(args.library) || 'the default library';
  return {
    verb: on ? 'Watch' : 'Unwatch',
    icon: 'bell',
    title: `${on ? 'Watch' : 'Stop watching'} ${library}`,
    subtitle,
    confirmLabel: on ? 'Watch library' : 'Stop watching',
    body: {
      kind: 'access',
      mode: on ? 'watch' : 'unwatch',
      who: [],
      on: ref(library, 'Library', text(args.site)),
      details: [
        {
          label: 'You will',
          value: on ? 'be told when files in it change' : 'stop being told when files change',
        },
      ],
    },
  };
}

/** Tags that end a line of text when closed or self-closed. */
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'tr', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: ' ' };

/**
 * Page HTML as the text a person would read, for a card that cannot render
 * it. A scanner rather than a chain of regular expressions: tags are
 * dropped by walking the string once (so no input can leave half a tag
 * behind), and entities are decoded in the same single pass over what is
 * left (so `&amp;lt;` becomes `&lt;`, never `<`). The result goes onto the
 * card through textContent and is never parsed as HTML.
 */
export function htmlText(html: string): string {
  let out = '';
  let index = 0;
  while (index < html.length) {
    const char = html.charAt(index);
    if (char !== '<') {
      out += char;
      index += 1;
      continue;
    }
    const end = html.indexOf('>', index);
    if (end === -1) break;
    const name = (
      /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(index + 1, end))?.[1] ?? ''
    ).toLowerCase();
    const closing = html.charAt(index + 1) === '/';
    if (BLOCK_TAGS.has(name) && (closing || name === 'br')) out += '\n';
    index = end + 1;
  }
  const decoded = out.replace(
    /&(amp|lt|gt|nbsp);/g,
    (_match, entity: string) => ENTITIES[entity] ?? ''
  );
  return clip(decoded.replace(/\n{3,}/g, '\n\n').trim(), 6000);
}

const SHARE = 'File share';

export const DOCUMENT_PREVIEWS: Record<string, PreviewBuilder> = {
  ...family(SERVICES[0]!),
  ...family(SERVICES[1]!),

  fileshare_create_folder: (args) => ({
    verb: 'Create',
    icon: 'folder',
    title: `Create the folder ${text(args.path).split('/').filter(Boolean).pop() ?? text(args.path)}`,
    subtitle: SHARE,
    confirmLabel: 'Create folder',
    body: {
      kind: 'fileop',
      mode: 'create',
      items: [
        {
          name: text(args.path).split('/').filter(Boolean).pop() ?? text(args.path),
          type: 'folder',
        },
      ],
      to: { path: text(args.path) },
    },
  }),

  fileshare_move_entry: (args) => {
    const name = text(args.path).split('/').filter(Boolean).pop() ?? text(args.path);
    return {
      verb: 'Move',
      icon: 'folder',
      title: `Move ${name}`,
      subtitle: SHARE,
      confirmLabel: 'Move',
      body: {
        kind: 'fileop',
        mode: 'move',
        items: [{ name, path: text(args.path), type: 'file' }],
        to: { path: text(args.toFolder) },
      },
    };
  },

  fileshare_rename_entry: (args) => {
    const name = text(args.path).split('/').filter(Boolean).pop() ?? text(args.path);
    return {
      verb: 'Rename',
      icon: 'doc',
      title: `Rename ${name}`,
      subtitle: SHARE,
      confirmLabel: 'Rename',
      editable: [{ key: 'newName', label: 'New name', multiline: false }],
      body: {
        kind: 'fileop',
        mode: 'rename',
        items: [{ name, path: text(args.path), type: 'file' }],
        to: { name: text(args.newName) },
      },
    };
  },
};
