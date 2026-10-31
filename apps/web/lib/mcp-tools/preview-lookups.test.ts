/* eslint-disable @typescript-eslint/consistent-type-assertions */
/** The Mirth, OnBase and Zoom preview lookups, with mocked clients. */

import type { MCPToolContext } from './common';
import { lookupNames } from './lookup';
import { nameKey } from './previews/card';
import { registerMirthPreviewLookups } from './mirth/preview-lookups';
import {
  registerOnbaseAdminPreviewLookups,
  registerOnbasePreviewLookups,
} from './onbase/preview-lookups';
import { registerZoomPreviewLookups } from './zoom/preview-lookups';
import type { ConnectedInstance } from '@renkei/connector-mirth';
import type { ZoomAuth } from './zoom/zoom-auth';

const ctx = () => ({}) as MCPToolContext;
const INSTANCE = '11111111-2222-4333-8444-555555555555';
const CHANNEL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('mirth lookups', () => {
  const connected = [
    { instance: { id: INSTANCE, name: 'Prod', environment: 'prod' } },
  ] as unknown as ConnectedInstance[];
  const directory = {
    entries: jest.fn(async (_i: string, kind: string) =>
      kind === 'channel'
        ? [{ id: CHANNEL, name: 'ADT Inbound' }]
        : kind === 'connector'
          ? [{ id: '2', name: 'Lab Out' }]
          : kind === 'user'
            ? [{ id: '5', name: 'jdoe' }]
            : 'down'
    ),
  };

  it('resolves instance, channel, connector and user names', async () => {
    const c = ctx();
    registerMirthPreviewLookups(c, { listConnected: async () => connected, directory });
    const names = await lookupNames(c, 'mirth_control_connector', {
      instanceId: INSTANCE,
      channelId: CHANNEL,
      metaDataId: 2,
    });
    expect(names).toMatchObject({
      [nameKey('instance', INSTANCE)]: 'Prod',
      [nameKey('channel', CHANNEL)]: 'ADT Inbound',
      [nameKey('connector', '2')]: 'Lab Out',
    });
    const user = await lookupNames(c, 'mirth_update_user', { instanceId: 'prod', userId: 5 });
    expect(user[nameKey('user', '5')]).toBe('jdoe');
  });

  it('answers nothing when listings fail', async () => {
    const c = ctx();
    registerMirthPreviewLookups(c, {
      listConnected: async () => 'not connected',
      directory,
    });
    expect(await lookupNames(c, 'mirth_deploy_channels', { instanceId: INSTANCE })).toEqual({});
  });
});

describe('onbase lookups', () => {
  it('names the document and the types', async () => {
    const c = ctx();
    registerOnbasePreviewLookups(c, {
      documentName: async (id) => (id === '9' ? 'Invoice 1' : ''),
      catalog: async (kind) =>
        kind === 'document-types' ? [{ id: '4471', name: 'AP Invoice' }] : 'down',
    });
    const names = await lookupNames(c, 'onbase_reindex_document', {
      documentId: '9',
      targetDocumentType: '4471',
    });
    expect(names).toEqual({
      [nameKey('document', '9')]: 'Invoice 1',
      [nameKey('document type', '4471')]: 'AP Invoice',
    });
  });

  it('matches admin catalogs by id or name, and survives a throw', async () => {
    const c = ctx();
    registerOnbaseAdminPreviewLookups(c, {
      catalog: async (kind) => {
        if (kind === 'user-groups') throw new Error('boom');
        return kind === 'document-types' ? [{ id: '4471', name: 'AP Invoice' }] : [];
      },
    });
    const names = await lookupNames(c, 'onbase_admin_assign_document_type_user_groups', {
      documentType: '4471',
      userGroups: [{ userGroup: '77' }],
    });
    expect(names).toEqual({ [nameKey('document type', '4471')]: 'AP Invoice' });
  });
});

describe('zoom lookups', () => {
  const json = (body: unknown, ok = true) =>
    ({ ok, json: async () => body }) as unknown as Response;

  it('names a meeting, one occurrence and a doc', async () => {
    const c = ctx();
    const auth = {
      fetch: jest.fn(async (_s: readonly string[], path: string) =>
        path.startsWith('/meetings/')
          ? json({
              topic: 'Weekly sync',
              occurrences: [{ occurrence_id: '17', start_time: '2026-11-02T15:00:00Z' }],
            })
          : json({ file_name: 'Retro notes' })
      ),
    } as unknown as ZoomAuth;
    registerZoomPreviewLookups(c, auth, () => ['s']);
    expect(
      await lookupNames(c, 'zoom_delete_meeting', { meetingId: '123', occurrenceId: '17' })
    ).toEqual({
      [nameKey('meeting', '123')]: 'Weekly sync',
      [nameKey('occurrence', '17')]: '2026-11-02T15:00:00Z',
    });
    expect(await lookupNames(c, 'zoom_append_to_doc', { fileId: 'f1' })).toEqual({
      [nameKey('doc', 'f1')]: 'Retro notes',
    });
  });

  it('leaves names out when Zoom refuses', async () => {
    const c = ctx();
    const auth = { fetch: async () => json({}, false) } as unknown as ZoomAuth;
    registerZoomPreviewLookups(c, auth, () => []);
    expect(await lookupNames(c, 'zoom_update_meeting', { meetingId: '123' })).toEqual({});
  });
});
