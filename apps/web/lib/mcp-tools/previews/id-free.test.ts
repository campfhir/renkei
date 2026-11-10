/** Mirth, OnBase and Zoom cards show names, never ids. */

import { PREVIEW_BUILDERS } from './index';
import { nameKey } from './card';
import { looksLikeId } from './readable';

const INSTANCE = '11111111-2222-4333-8444-555555555555';
const CHANNEL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ALERT = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEMPLATE = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TASK = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RESOURCE = 'eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const build = (tool: string, args: Record<string, unknown>, names: Record<string, string> = {}) => {
  const builder = PREVIEW_BUILDERS[tool];
  if (!builder) throw new Error(`no builder for ${tool}`);
  return JSON.stringify(builder(args, names));
};

const CASES: [string, Record<string, unknown>, string[]][] = [
  ['mirth_deploy_channels', { instanceId: INSTANCE, channelIds: [CHANNEL] }, [INSTANCE, CHANNEL]],
  [
    'mirth_undeploy_channels',
    { instanceId: INSTANCE, channelIds: [CHANNEL, 'x-y'] },
    [INSTANCE, CHANNEL],
  ],
  [
    'mirth_control_channels',
    { instanceId: INSTANCE, channelIds: [CHANNEL], action: 'start' },
    [CHANNEL],
  ],
  [
    'mirth_control_connector',
    { instanceId: INSTANCE, channelId: CHANNEL, metaDataId: 2, action: 'stop' },
    [CHANNEL],
  ],
  [
    'mirth_set_channel_enabled',
    { instanceId: INSTANCE, channelId: CHANNEL, enabled: true },
    [CHANNEL],
  ],
  [
    'mirth_set_channel_initial_state',
    { instanceId: INSTANCE, channelId: CHANNEL, initialState: 'STARTED' },
    [CHANNEL],
  ],
  [
    'mirth_send_message',
    { instanceId: INSTANCE, channelId: CHANNEL, content: 'hi', destinationMetaDataIds: [3] },
    [CHANNEL],
  ],
  [
    'mirth_reprocess_messages',
    { instanceId: INSTANCE, channelId: CHANNEL, messageId: 98765 },
    [CHANNEL, '98765'],
  ],
  ['mirth_set_alert_enabled', { instanceId: INSTANCE, alertId: ALERT, enabled: false }, [ALERT]],
  [
    'mirth_set_channels_enabled',
    { instanceId: INSTANCE, channelId: [CHANNEL], enabled: true },
    [CHANNEL],
  ],
  [
    'mirth_process_raw_message',
    { instanceId: INSTANCE, channelId: CHANNEL, rawMessage: 'x' },
    [CHANNEL],
  ],
  ['mirth_reload_resource', { instanceId: INSTANCE, resourceId: RESOURCE }, [RESOURCE]],
  ['mirth_update_user', { instanceId: INSTANCE, userId: 42, user: '<user/>' }, ['42']],
  ['mirth_update_alert', { instanceId: INSTANCE, alertId: ALERT, alertModel: '<a/>' }, [ALERT]],
  [
    'mirth_update_code_template',
    { instanceId: INSTANCE, codeTemplateId: TEMPLATE, codeTemplate: '<t/>' },
    [TEMPLATE],
  ],
  ['mirth_cancel_database_task', { instanceId: INSTANCE, databaseTaskId: TASK }, [TASK]],
  [
    'mirth_export_message_attachment',
    {
      instanceId: INSTANCE,
      channelId: CHANNEL,
      messageId: 5551234,
      attachmentId: 'a'.repeat(12) + '1234',
      filePath: '/x',
    },
    [CHANNEL, '5551234'],
  ],
  ['onbase_add_note', { documentId: '90210123', text: 'n' }, ['90210123']],
  [
    'onbase_reindex_document',
    { documentId: '90210123', targetDocumentType: '4471' },
    ['90210123', '4471'],
  ],
  [
    'onbase_update_keywords',
    { documentId: '90210123', keywords: [{ type: '8812', values: ['a'] }] },
    ['90210123', '8812'],
  ],
  [
    'onbase_archive_document',
    { documentType: '4471', keywords: [{ type: '8812', values: ['a'] }] },
    ['4471', '8812'],
  ],
  ['onbase_admin_update_document_type', { documentType: '4471', fields: { name: 'x' } }, ['4471']],
  ['onbase_admin_update_keyword_type', { keywordType: '8812', fields: { name: 'x' } }, ['8812']],
  [
    'onbase_admin_assign_keyword_types',
    { documentType: '4471', assignments: [{ keywordType: '8812' }] },
    ['4471', '8812'],
  ],
  [
    'onbase_admin_assign_document_type_user_groups',
    { documentType: '4471', userGroups: [{ userGroup: '77' }] },
    ['4471', '77'],
  ],
  [
    'onbase_admin_assign_document_type_group_user_groups',
    { documentTypeGroup: '4472', userGroups: [{ userGroup: '77' }] },
    ['4472', '77'],
  ],
  [
    'zoom_update_meeting',
    { meetingId: '85412345678', occurrenceId: '1700000000000', agenda: 'a' },
    ['85412345678', '1700000000000'],
  ],
  [
    'zoom_delete_meeting',
    { meetingId: '85412345678', occurrenceId: '1700000000000' },
    ['85412345678', '1700000000000'],
  ],
  [
    'zoom_append_to_doc',
    { fileId: 'AbCdEfGhIjKlMnOpQr12Xy', text: 't' },
    ['AbCdEfGhIjKlMnOpQr12Xy'],
  ],
];

describe('cards without a looked-up name', () => {
  it.each(CASES)('%s never shows an id', (tool, args, ids) => {
    const card = build(tool, args);
    for (const id of ids) expect(card).not.toContain(id);
  });
});

describe('cards with looked-up names', () => {
  it('names the channel, instance and connector', () => {
    const card = build(
      'mirth_control_connector',
      { instanceId: INSTANCE, channelId: CHANNEL, metaDataId: 2, action: 'stop' },
      {
        [nameKey('instance', INSTANCE)]: 'Prod',
        [nameKey('channel', CHANNEL)]: 'ADT Inbound',
        [nameKey('connector', '2')]: 'Lab Out',
      }
    );
    expect(card).toContain('ADT Inbound');
    expect(card).toContain('Lab Out');
    expect(card).toContain('Mirth Connect · Prod');
    expect(card).not.toContain(CHANNEL);
  });

  it('keeps a channel name the person typed', () => {
    expect(
      build('mirth_set_channel_enabled', {
        instanceId: 'Prod',
        channelId: 'ADT Inbound',
        enabled: true,
      })
    ).toContain('ADT Inbound');
  });

  it('names the document and its type', () => {
    const card = build(
      'onbase_reindex_document',
      { documentId: '90210123', targetDocumentType: '4471' },
      {
        [nameKey('document', '90210123')]: 'Invoice 2026-01',
        [nameKey('document type', '4471')]: 'AP Invoice',
      }
    );
    expect(card).toContain('Invoice 2026-01');
    expect(card).toContain('AP Invoice');
  });

  it('names the meeting, its occurrence and a doc', () => {
    const meeting = build(
      'zoom_delete_meeting',
      { meetingId: '85412345678', occurrenceId: '1700000000000' },
      {
        [nameKey('meeting', '85412345678')]: 'Weekly sync',
        [nameKey('occurrence', '1700000000000')]: '2026-11-02T15:00:00Z',
      }
    );
    expect(meeting).toContain('Weekly sync');
    expect(meeting).toContain('2026-11-02T15:00:00Z');
    const doc = build(
      'zoom_append_to_doc',
      { fileId: 'AbCdEfGhIjKlMnOpQr12Xy', text: 't' },
      {
        [nameKey('doc', 'AbCdEfGhIjKlMnOpQr12Xy')]: 'Retro notes',
      }
    );
    expect(doc).toContain('Retro notes');
  });
});

describe('looksLikeId', () => {
  it('flags handles and spares wording', () => {
    expect(looksLikeId(CHANNEL)).toBe(true);
    expect(looksLikeId('85412345678')).toBe(true);
    expect(looksLikeId('AbCdEfGhIjKlMnOpQr12Xy')).toBe(true);
    expect(looksLikeId('ADT Inbound')).toBe(false);
    expect(looksLikeId('Prod')).toBe(false);
  });
});
