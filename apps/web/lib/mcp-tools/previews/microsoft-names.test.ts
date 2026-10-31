/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { nameKey } from './card';
import { DOCUMENT_PREVIEWS } from './documents';
import { ONENOTE_PREVIEWS } from './onenote';
import { OUTLOOK_PREVIEWS } from './outlook';
import { TEAMS_PREVIEWS } from './teams';

type Table = Record<string, (a: never, n: never) => unknown>;
const card = (table: Table, tool: string) => {
  const build = table[tool] as (a: Record<string, unknown>, n: Record<string, string>) => unknown;
  return (args: Record<string, unknown>, names: Record<string, string> = {}) =>
    JSON.stringify(build(args, names));
};

// Ids shaped like the ones Graph hands out.
const DRIVE_ITEM = '01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K';
const FOLDER = '01BYE5RZ5MYLM2SMX75ZBIPQZIHT6OAYPB';
const PERMISSION = 'aTowIy5mfG1lbWJlcnNoaXB8YWxpY2VAZXhhbXBsZS5jb20';
const PAGE = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const MESSAGE = 'AAMkAGI2THVSAAA=';
const GRAPH_FOLDER = 'AAMkAGI2TG93AAA=';
const NOTEBOOK = '1-ab12cd34-5678-90ef-aaaa-bbbbccccdddd';
const SECTION = '1-eeee1111-2222-3333-4444-555566667777';
const CHAT = '19:abcdef0123456789@thread.v2';
const CHANNEL = '19:channelchannelchannel@thread.tacv2';
const TEAM = '8d1e6f56-0a48-4bb1-9f57-3c2f6f2a1b11';
const REPLY = '1699999999999';
const SITE =
  'contoso.sharepoint.com,5d2a8a9c-1111-2222-3333-444455556666,9c8b7a65-aaaa-bbbb-cccc-ddddeeeeffff';

const ids = [
  DRIVE_ITEM,
  FOLDER,
  PERMISSION,
  PAGE,
  MESSAGE,
  GRAPH_FOLDER,
  NOTEBOOK,
  SECTION,
  CHAT,
  CHANNEL,
  TEAM,
  REPLY,
  SITE,
];
const clean = (json: string) => {
  for (const id of ids) expect(json).not.toContain(id);
};

describe('OneDrive and SharePoint cards', () => {
  const family = ['onedrive', 'sharepoint'];

  it.each(family)('%s: names the item, destination folder and person; no ids on fallback', (p) => {
    const names = {
      [nameKey('item', DRIVE_ITEM)]: 'Plan.docx',
      [nameKey('folder', FOLDER)]: '/Specs/2026',
      [nameKey('permission', PERMISSION)]: 'Alice Smith',
    };
    const move = card(DOCUMENT_PREVIEWS, `${p}_move_document`);
    const args = { itemId: DRIVE_ITEM, destinationFolderId: FOLDER };
    expect(move(args, names)).toContain('Plan.docx');
    expect(move(args, names)).toContain('/Specs/2026');
    expect(move(args)).toContain('Another folder');
    clean(move(args, names));
    clean(move(args));

    const copy = card(DOCUMENT_PREVIEWS, `${p}_copy_document`);
    expect(copy(args, names)).toContain('/Specs/2026');
    clean(copy(args));

    const revoke = card(DOCUMENT_PREVIEWS, `${p}_remove_user_from_document`);
    const revokeArgs = { itemId: DRIVE_ITEM, permissionId: PERMISSION };
    expect(revoke(revokeArgs, names)).toContain('Alice Smith');
    expect(revoke(revokeArgs)).toContain('a person’s access');
    clean(revoke(revokeArgs));
    clean(revoke(revokeArgs, names));

    for (const tool of ['rename_document', 'delete_document']) {
      clean(card(DOCUMENT_PREVIEWS, `${p}_${tool}`)({ itemId: DRIVE_ITEM, newName: 'x' }));
    }
  });

  it('keeps a typed email, and a pasted site address reads as its site', () => {
    const revoke = card(DOCUMENT_PREVIEWS, 'sharepoint_remove_user_from_document');
    expect(
      revoke({ path: 'a/b.docx', email: 'bo@example.com', permissionId: PERMISSION })
    ).toContain('bo@example.com');
    const watch = card(DOCUMENT_PREVIEWS, 'sharepoint_watch_library');
    expect(watch({ site: 'https://contoso.sharepoint.com/sites/Finance' })).toContain('Finance');
  });

  it('sharepoint pages: title by lookup, generic phrase otherwise, never the id or site id', () => {
    const names = { [nameKey('page', PAGE)]: 'Onboarding', [nameKey('site', SITE)]: 'Finance' };
    for (const tool of [
      'sharepoint_update_page',
      'sharepoint_publish_page',
      'sharepoint_delete_page',
    ]) {
      const build = card(DOCUMENT_PREVIEWS, tool);
      const args = { site: SITE, pageId: PAGE };
      expect(build(args, names)).toContain('Onboarding');
      expect(build(args, names)).toContain('Finance');
      expect(build(args)).toContain('the page');
      clean(build(args, names));
      clean(build(args));
    }
    clean(card(DOCUMENT_PREVIEWS, 'sharepoint_watch_library')({ site: SITE }));
    clean(card(DOCUMENT_PREVIEWS, 'sharepoint_create_page')({ site: SITE, title: 'T' }));
  });
});

describe('OneNote cards', () => {
  const names = {
    [nameKey('notebook', NOTEBOOK)]: 'Team handbook',
    [nameKey('section', SECTION)]: 'Onboarding',
    [nameKey('sectionNotebook', SECTION)]: 'Team handbook',
    [nameKey('page', PAGE)]: 'Day one',
    [nameKey('group', TEAM)]: 'Platform team',
  };

  it('names notebook, section, page and group', () => {
    expect(
      card(ONENOTE_PREVIEWS, 'onenote_create_section')(
        { name: 'S', notebookId: NOTEBOOK, groupId: TEAM },
        names
      )
    ).toMatch(/Team handbook[\s\S]*Platform team|Platform team[\s\S]*Team handbook/);
    expect(
      card(ONENOTE_PREVIEWS, 'onenote_create_page')({ title: 'T', sectionId: SECTION }, names)
    ).toContain('Section Onboarding');
    expect(
      card(ONENOTE_PREVIEWS, 'onenote_append_to_page')({ pageId: PAGE, markdown: 'x' }, names)
    ).toContain('“Day one”');
    expect(card(ONENOTE_PREVIEWS, 'onenote_delete_page')({ pageId: PAGE }, names)).toContain(
      'Delete the page “Day one”'
    );
  });

  it('falls back to generic phrases, never an id', () => {
    const calls: [string, Record<string, unknown>][] = [
      ['onenote_create_section', { name: 'S', notebookId: NOTEBOOK, groupId: TEAM }],
      ['onenote_create_section', { name: 'S', notebookId: NOTEBOOK, site: SITE }],
      ['onenote_create_page', { title: 'T', sectionId: SECTION }],
      ['onenote_append_to_page', { pageId: PAGE, markdown: 'x' }],
      ['onenote_delete_page', { pageId: PAGE }],
    ];
    for (const [tool, args] of calls) clean(card(ONENOTE_PREVIEWS, tool)(args));
    expect(card(ONENOTE_PREVIEWS, 'onenote_delete_page')({ pageId: PAGE })).toContain(
      'Delete the page'
    );
  });
});

describe('Outlook mailbox cards', () => {
  const names = {
    [nameKey('message', MESSAGE)]: 'Quarterly numbers',
    [nameKey('folder', GRAPH_FOLDER)]: 'Projects',
  };

  it('names the message and the folder', () => {
    expect(
      card(OUTLOOK_PREVIEWS, 'outlook_mark_message')({ messageId: MESSAGE, isRead: true }, names)
    ).toContain('Mark “Quarterly numbers” as read');
    expect(
      card(OUTLOOK_PREVIEWS, 'outlook_move_message')(
        { messageId: MESSAGE, destinationFolder: GRAPH_FOLDER },
        names
      )
    ).toContain('to Projects');
    expect(
      card(OUTLOOK_PREVIEWS, 'outlook_rename_mail_folder')(
        { folderId: GRAPH_FOLDER, displayName: 'New' },
        names
      )
    ).toContain('Rename Projects to New');
    expect(
      card(OUTLOOK_PREVIEWS, 'outlook_delete_mail_folder')({ folderId: GRAPH_FOLDER }, names)
    ).toContain('Projects');
    expect(
      card(OUTLOOK_PREVIEWS, 'outlook_create_mail_folder')(
        { displayName: 'N', parentFolderId: GRAPH_FOLDER },
        names
      )
    ).toContain('Inside Projects');
  });

  it('keeps well-known folder names readable and never shows an id on fallback', () => {
    expect(
      card(
        OUTLOOK_PREVIEWS,
        'outlook_move_message'
      )({ messageId: MESSAGE, destinationFolder: 'deleteditems' })
    ).toContain('Deleted Items');
    const calls: [string, Record<string, unknown>][] = [
      ['outlook_mark_message', { messageId: MESSAGE, isRead: false }],
      ['outlook_flag_message', { messageId: MESSAGE, status: 'flagged' }],
      ['outlook_categorize_message', { messageId: MESSAGE, add: ['Red'] }],
      ['outlook_move_message', { messageId: MESSAGE, destinationFolder: GRAPH_FOLDER }],
      ['outlook_create_mail_folder', { displayName: 'N', parentFolderId: GRAPH_FOLDER }],
      ['outlook_rename_mail_folder', { folderId: GRAPH_FOLDER, displayName: 'N' }],
      ['outlook_delete_mail_folder', { folderId: GRAPH_FOLDER }],
      [
        'outlook_start_bulk_mail_job',
        {
          action: 'move',
          messageIds: [MESSAGE],
          destinationFolder: GRAPH_FOLDER,
        },
      ],
      [
        'outlook_start_bulk_mail_job',
        { action: 'archive', filters: { folder: GRAPH_FOLDER, isRead: false } },
      ],
    ];
    for (const [tool, args] of calls) clean(card(OUTLOOK_PREVIEWS, tool)(args));
    expect(
      card(
        OUTLOOK_PREVIEWS,
        'outlook_move_message'
      )({ messageId: MESSAGE, destinationFolder: GRAPH_FOLDER })
    ).toContain('Move a message to another folder');
  });

  it('bulk by id lists the first subjects and counts the rest', () => {
    const many = ['a', 'b', 'c', 'd', 'e'];
    const subjects = Object.fromEntries(
      many.slice(0, 3).map((id) => [nameKey('message', id), `Subject ${id}`])
    );
    const json = card(OUTLOOK_PREVIEWS, 'outlook_start_bulk_mail_job')(
      { action: 'archive', messageIds: many },
      subjects
    );
    expect(json).toContain('“Subject a”, “Subject b”, “Subject c” and 2 other messages');
  });
});

describe('Teams cards', () => {
  const names = {
    [nameKey('chat', CHAT)]: 'Dana Lee',
    [nameKey('team', TEAM)]: 'Platform',
    [nameKey('channel', CHANNEL)]: 'General',
    [nameKey('post', REPLY)]: 'by Sam: “Ship it?”',
  };

  it('names chat, team, channel and the post replied to', () => {
    expect(
      card(TEAMS_PREVIEWS, 'teams_send_chat_message')({ chatId: CHAT, markdown: 'hi' }, names)
    ).toContain('chat with Dana Lee');
    const channel = card(TEAMS_PREVIEWS, 'teams_send_channel_message')(
      { teamId: TEAM, channelId: CHANNEL, replyToId: REPLY, markdown: 'yes' },
      names
    );
    expect(channel).toContain('Reply in General');
    expect(channel).toContain('Team Platform');
    expect(channel).toContain('by Sam: “Ship it?”');
    clean(channel);
  });

  it('falls back to generic phrases, never an id', () => {
    const chat = card(TEAMS_PREVIEWS, 'teams_send_chat_message')({ chatId: CHAT, markdown: 'hi' });
    expect(chat).toContain('a Teams chat');
    clean(chat);
    const channel = card(
      TEAMS_PREVIEWS,
      'teams_send_channel_message'
    )({
      teamId: TEAM,
      channelId: CHANNEL,
      replyToId: REPLY,
      markdown: 'yes',
    });
    expect(channel).toContain('Reply to a post');
    clean(channel);
  });

  it('keeps a typed email for a 1:1 message', () => {
    expect(
      card(
        TEAMS_PREVIEWS,
        'teams_send_chat_message'
      )({ toEmail: 'dana@example.com', markdown: 'hi' })
    ).toContain('dana@example.com');
  });
});
