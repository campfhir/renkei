/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The Microsoft 365 preview lookups against a stubbed Graph (same harness as
 * teams/tools.test.ts): names come back keyed for the builders, every call is
 * a GET, and a failing Graph leaves the names out.
 */

jest.mock('@renkei/provider-grants', () => ({ MICROSOFT: 'microsoft' }));
jest.mock('@renkei/delegate-client', () => {
  const actual =
    jest.requireActual<typeof import('@renkei/delegate-client')>('@renkei/delegate-client');
  return {
    ...actual,
    delegateGrants: () => ({
      describe: jest.fn(async () => ({
        ok: true,
        val: { accountId: 'acct-1', metadata: { upn: 'alice@example.com' } },
      })),
    }),
    grantFetch: jest.fn((ref: Parameters<typeof actual.grantKeyOf>[0]) =>
      actual.authedFetch(
        jest.fn((url: string, init?: RequestInit) => fetch(url, init)),
        actual.grantKeyOf(ref)
      )
    ),
  };
});
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: true, val: 'key' }) }));
jest.mock('@renkei/db', () => ({ getDataStore: () => ({}) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import type { MCPToolContext } from '../common';
import { lookupNames } from '../lookup';
import { nameKey } from '../previews/card';
import { oauthGraphAuth } from './graph-auth';
import { registerDocumentPreviewLookups } from './preview-lookups';
import { registerOneNotePreviewLookups } from '../onenote/preview-lookups';
import { registerOutlookPreviewLookups } from '../outlook/preview-lookups';
import { registerSharePointPreviewLookups } from '../sharepoint/preview-lookups';
import { registerTeamsPreviewLookups } from '../teams/preview-lookups';

let routes: { match: string; body: unknown; status?: number }[] = [];
let requests: { url: string; method: string }[] = [];

beforeEach(() => {
  routes = [];
  requests = [];
  global.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = decodeURIComponent(String(input));
    requests.push({ url, method: init?.method ?? 'GET' });
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const setup = () => {
  const context = { subject: 'subject-1', origin: 'https://renkei.example' } as MCPToolContext;
  return { context, auth: oauthGraphAuth(context) };
};

describe('Microsoft 365 preview lookups', () => {
  it('OneDrive: names an item given by id, the destination folder and a permission', async () => {
    const { context, auth } = setup();
    registerDocumentPreviewLookups(context, auth, 'onedrive');
    routes = [
      { match: '/me/drive?', body: { id: 'drive-1' } },
      {
        match: '/drives/drive-1/items/item-9/permissions/perm-3',
        body: { grantedToV2: { user: { displayName: 'Alice Smith' } } },
      },
      {
        match: '/drives/drive-1/items/folder-4',
        body: { name: '2026', parentReference: { path: '/drives/drive-1/root:/Specs' } },
      },
      { match: '/drives/drive-1/items/item-9', body: { id: 'item-9', name: 'Plan.docx' } },
    ];
    const moved = await lookupNames(context, 'onedrive_move_document', {
      itemId: 'item-9',
      destinationFolderId: 'folder-4',
    });
    expect(moved).toEqual({
      [nameKey('item', 'item-9')]: 'Plan.docx',
      [nameKey('folder', 'folder-4')]: '/Specs/2026',
    });
    const revoked = await lookupNames(context, 'onedrive_remove_user_from_document', {
      itemId: 'item-9',
      permissionId: 'perm-3',
    });
    expect(revoked[nameKey('permission', 'perm-3')]).toBe('Alice Smith');
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('SharePoint: names the site and a page', async () => {
    const { context, auth } = setup();
    registerSharePointPreviewLookups(context, auth);
    routes = [
      { match: '/pages/page-7/microsoft.graph.sitePage', body: { title: 'Onboarding' } },
      { match: '/sites/contoso.sharepoint.com', body: { id: 'site-1', displayName: 'Finance' } },
    ];
    const names = await lookupNames(context, 'sharepoint_delete_page', {
      site: 'https://contoso.sharepoint.com/sites/Finance',
      pageId: 'page-7',
    });
    expect(names).toEqual({
      [nameKey('site', 'https://contoso.sharepoint.com/sites/Finance')]: 'Finance',
      [nameKey('page', 'page-7')]: 'Onboarding',
    });
  });

  it('OneNote: names notebook, section (with its notebook) and page', async () => {
    const { context, auth } = setup();
    registerOneNotePreviewLookups(context, auth);
    routes = [
      { match: '/me/onenote/notebooks/nb-1', body: { displayName: 'Handbook' } },
      {
        match: '/me/onenote/sections/sec-2',
        body: { displayName: 'Onboarding', parentNotebook: { displayName: 'Handbook' } },
      },
      { match: '/me/onenote/pages/pg-3', body: { title: 'Day one' } },
    ];
    const names = await lookupNames(context, 'onenote_create_page', {
      sectionId: 'sec-2',
      notebookId: 'nb-1',
      pageId: 'pg-3',
    });
    expect(names).toEqual({
      [nameKey('notebook', 'nb-1')]: 'Handbook',
      [nameKey('section', 'sec-2')]: 'Onboarding',
      [nameKey('sectionNotebook', 'sec-2')]: 'Handbook',
      [nameKey('page', 'pg-3')]: 'Day one',
    });
  });

  it('Outlook: names a message and a folder, and a few bulk subjects', async () => {
    const { context, auth } = setup();
    registerOutlookPreviewLookups(context, auth);
    routes = [
      { match: '/me/messages/m1', body: { subject: 'Quarterly numbers' } },
      { match: '/me/messages/m2', body: { subject: 'Offsite' } },
      { match: '/me/mailFolders/f1', body: { displayName: 'Projects' } },
    ];
    expect(
      await lookupNames(context, 'outlook_move_message', {
        messageId: 'm1',
        destinationFolder: 'f1',
      })
    ).toEqual({
      [nameKey('message', 'm1')]: 'Quarterly numbers',
      [nameKey('folder', 'f1')]: 'Projects',
    });
    expect(
      await lookupNames(context, 'outlook_start_bulk_mail_job', {
        messageIds: ['m1', 'm2'],
        destinationFolder: 'f1',
      })
    ).toEqual({
      [nameKey('message', 'm1')]: 'Quarterly numbers',
      [nameKey('message', 'm2')]: 'Offsite',
      [nameKey('folder', 'f1')]: 'Projects',
    });
  });

  it('Teams: names a chat by its other members, a channel, a team and the post replied to', async () => {
    const { context, auth } = setup();
    registerTeamsPreviewLookups(context, auth);
    routes = [
      {
        match: '/chats/chat-1',
        body: {
          members: [
            { displayName: 'Alice', email: 'alice@example.com' },
            { displayName: 'Dana Lee', email: 'dana@example.com' },
          ],
        },
      },
      {
        match: '/channels/ch-1/messages/post-1',
        body: {
          from: { user: { displayName: 'Sam' } },
          body: { contentType: 'html', content: '<p>Ship it?</p>' },
        },
      },
      { match: '/channels/ch-1', body: { displayName: 'General' } },
      { match: '/teams/team-1', body: { displayName: 'Platform' } },
    ];
    expect(await lookupNames(context, 'teams_send_chat_message', { chatId: 'chat-1' })).toEqual({
      [nameKey('chat', 'chat-1')]: 'Dana Lee',
    });
    expect(
      await lookupNames(context, 'teams_send_channel_message', {
        teamId: 'team-1',
        channelId: 'ch-1',
        replyToId: 'post-1',
      })
    ).toEqual({
      [nameKey('team', 'team-1')]: 'Platform',
      [nameKey('channel', 'ch-1')]: 'General',
      [nameKey('post', 'post-1')]: 'by Sam: “Ship it?”',
    });
  });

  it('leaves the names out when Graph refuses', async () => {
    const { context, auth } = setup();
    registerOutlookPreviewLookups(context, auth);
    registerTeamsPreviewLookups(context, auth);
    routes = [{ match: '/', body: {}, status: 403 }];
    expect(
      await lookupNames(context, 'outlook_mark_message', { messageId: 'm1', isRead: true })
    ).toEqual({});
    expect(await lookupNames(context, 'teams_send_chat_message', { chatId: 'c' })).toEqual({});
  });
});
