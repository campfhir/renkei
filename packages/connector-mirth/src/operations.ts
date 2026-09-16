/**
 * The Mirth Connect 4.5.2 REST API as a table of named operations — one
 * entry per route the curated tools do not already phrase, each with its
 * own path parameters, query parameters and body shape. The web app turns
 * every entry into a `mirth_<tool>` MCP tool with a real input schema, so
 * a model gets native-looking, validated tools for the whole API rather
 * than a generic "issue a request" escape hatch.
 *
 * Transcribed from the 4.5.2 servlet interfaces
 * (`com.mirth.connect.client.core.api.servlets.*ServletInterface`). Paths
 * are relative to `/api`; `{name}` marks a path parameter and must have a
 * matching `params` entry with `in: 'path'`.
 *
 * Left out on purpose:
 *   - the `POST … _getX` / `_search` / `_removeAllMessagesPost` variants
 *     that exist only so a very long id list can ride a body instead of a
 *     query string — the same operation, already named once;
 *   - login / logout / inactivityLogout, which the worker owns (the
 *     session is Renkei's to manage, never the model's);
 *   - `POST /extensions/_install`, which takes a zip upload — file bytes
 *     never travel through tool arguments here;
 *   - routes a curated tool already covers (marked in the tool module).
 *
 * `permission` is what the exposure gate reads (permissions.ts): the tool
 * registers when some connected instance grants it, and every call checks
 * it again on the instance named. `kind` says how the tool behaves: 'read'
 * is annotated read-only, 'act' writes, 'destructive' is preview + confirm
 * only — every DELETE and the writes that remove data, purge stores or
 * replace the server as a whole, the same classification
 * `isDestructiveRequest` makes.
 */

import type { HttpMethod } from './api';
import type { MirthPermission } from './permissions';

export type ParamType =
  | 'string'
  | 'int'
  | 'boolean'
  | 'string[]'
  | 'int[]'
  | 'iso-date'
  /** One of the values; `multiple` makes it a repeatable list. */
  | { enum: readonly [string, ...string[]]; multiple?: boolean };

export interface ParamSpec {
  name: string;
  in: 'path' | 'query';
  type: ParamType;
  required?: boolean;
  description: string;
}

export type BodySpec =
  /** One verbatim document — the XML the Administrator exports, or plain text. */
  | { kind: 'xml' | 'text'; name: string; description: string; required?: boolean }
  /** application/x-www-form-urlencoded fields. */
  | { kind: 'form'; fields: ParamSpec[] }
  /** multipart/form-data parts, each an XML document. */
  | { kind: 'multipart'; parts: { name: string; description: string; required?: boolean }[] };

export type OperationKind = 'read' | 'act' | 'destructive';

export interface OperationSpec {
  /** The tool suffix: `mirth_<tool>`. */
  tool: string;
  /** The permission a connection must grant for the tool to register and run. */
  permission: MirthPermission;
  title: string;
  description: string;
  method: HttpMethod;
  path: string;
  params: ParamSpec[];
  body?: BodySpec;
  kind: OperationKind;
  /** What to ask Mirth for; default application/json. */
  accept?: 'application/json' | 'application/xml' | 'text/plain';
}

const id = (name: string, description: string): ParamSpec => ({
  name,
  in: 'path',
  type: 'string',
  required: true,
  description,
});
const q = (name: string, type: ParamType, description: string, required = false): ParamSpec => ({
  name,
  in: 'query',
  type,
  required,
  description,
});
const xml = (name: string, description: string, required = true): BodySpec => ({
  kind: 'xml',
  name,
  description,
  required,
});

const CHANNEL_ID = id('channelId', 'The channel id (from mirth_list_channels).');
const MESSAGE_ID: ParamSpec = {
  name: 'messageId',
  in: 'path',
  type: 'int',
  required: true,
  description: 'The message id (from mirth_search_messages).',
};

/** The message filter Mirth accepts on its GET/DELETE/_reprocess/_export routes. */
const MESSAGE_FILTER: ParamSpec[] = [
  q('minMessageId', 'int', 'Lowest message id to match.'),
  q('maxMessageId', 'int', 'Highest message id to match.'),
  q('minOriginalId', 'int', 'Lowest original (reprocessed-from) message id.'),
  q('maxOriginalId', 'int', 'Highest original message id.'),
  q('minImportId', 'int', 'Lowest import id.'),
  q('maxImportId', 'int', 'Highest import id.'),
  q('startDate', 'iso-date', 'Received on or after (ISO 8601).'),
  q('endDate', 'iso-date', 'Received on or before (ISO 8601).'),
  q('textSearch', 'string', 'Free text searched across message content.'),
  q('textSearchRegex', 'boolean', 'Treat textSearch as a regular expression.'),
  q(
    'status',
    {
      enum: ['RECEIVED', 'FILTERED', 'TRANSFORMED', 'SENT', 'QUEUED', 'ERROR', 'PENDING'],
      multiple: true,
    },
    'Connector-message statuses to match.'
  ),
  q('includedMetaDataId', 'int[]', 'Connector metadata ids to include (0 = source).'),
  q('excludedMetaDataId', 'int[]', 'Connector metadata ids to exclude.'),
  q('serverId', 'string', 'The server id, in a cluster.'),
  q('rawContentSearch', 'string[]', 'Text the RAW content must contain.'),
  q('processedRawContentSearch', 'string[]', 'Text the processed raw content must contain.'),
  q('transformedContentSearch', 'string[]', 'Text the transformed content must contain.'),
  q('encodedContentSearch', 'string[]', 'Text the encoded content must contain.'),
  q('sentContentSearch', 'string[]', 'Text the sent content must contain.'),
  q('responseContentSearch', 'string[]', 'Text the response content must contain.'),
  q('responseTransformedContentSearch', 'string[]', 'Text the transformed response must contain.'),
  q('processedResponseContentSearch', 'string[]', 'Text the processed response must contain.'),
  q('connectorMapContentSearch', 'string[]', 'Text the connector map must contain.'),
  q('channelMapContentSearch', 'string[]', 'Text the channel map must contain.'),
  q('sourceMapContentSearch', 'string[]', 'Text the source map must contain.'),
  q('responseMapContentSearch', 'string[]', 'Text the response map must contain.'),
  q('processingErrorContentSearch', 'string[]', 'Text the processing error must contain.'),
  q('postprocessorErrorContentSearch', 'string[]', 'Text the postprocessor error must contain.'),
  q('responseErrorContentSearch', 'string[]', 'Text the response error must contain.'),
  q('metaDataSearch', 'string[]', 'Custom metadata search, as "column operator value".'),
  q('metaDataCaseInsensitiveSearch', 'string[]', 'Case-insensitive custom metadata search.'),
  q('textSearchMetaDataColumn', 'string[]', 'Custom metadata columns textSearch also scans.'),
  q('minSendAttempts', 'int', 'Minimum send attempts.'),
  q('maxSendAttempts', 'int', 'Maximum send attempts.'),
  q('attachment', 'boolean', 'Only messages with attachments.'),
  q('error', 'boolean', 'Only messages with an error.'),
];

const EVENT_FILTER: ParamSpec[] = [
  q('maxEventId', 'int', 'Highest event id to match.'),
  q('minEventId', 'int', 'Lowest event id to match.'),
  q(
    'levels',
    { enum: ['INFORMATION', 'WARNING', 'ERROR'], multiple: true },
    'Event levels to match.'
  ),
  q('startDate', 'iso-date', 'On or after (ISO 8601).'),
  q('endDate', 'iso-date', 'On or before (ISO 8601).'),
  q('name', 'string', 'Event name fragment.'),
  q('outcome', { enum: ['SUCCESS', 'FAILURE'] }, 'Outcome to match.'),
  q('userId', 'int', 'The acting user id.'),
  q('attributeSearch', 'string', 'Text the event attributes must contain.'),
  q('ipAddress', 'string', 'The originating IP address.'),
  q('serverId', 'string', 'The server id, in a cluster.'),
];

export const MIRTH_OPERATIONS: readonly OperationSpec[] = [
  // ---------------------------------------------------------------- channels
  {
    tool: 'get_channels',
    permission: 'channels.read',
    title: 'Channel definitions',
    description:
      'The full definitions of all channels, or of the ids given (GET /channels) — as JSON or ' +
      'the XML the Administrator exports.',
    method: 'GET',
    path: '/channels',
    params: [
      q('channelId', 'string[]', 'Only these channel ids; omit for all.'),
      q('pollingOnly', 'boolean', 'Only channels with a polling source connector.'),
      q(
        'includeCodeTemplateLibraries',
        'boolean',
        'Attach the code template libraries each channel uses.'
      ),
    ],
    kind: 'read',
  },
  {
    tool: 'get_channel_connector_names',
    permission: 'channels.read',
    title: 'Connector names of a channel',
    description:
      'The metaDataId → connector name map of one channel (GET /channels/{channelId}/connectorNames).',
    method: 'GET',
    path: '/channels/{channelId}/connectorNames',
    params: [CHANNEL_ID],
    kind: 'read',
  },
  {
    tool: 'get_channel_metadata_columns',
    permission: 'channels.read',
    title: 'Custom metadata columns of a channel',
    description:
      'The custom metadata columns a channel stores per message (GET /channels/{channelId}/metaDataColumns).',
    method: 'GET',
    path: '/channels/{channelId}/metaDataColumns',
    params: [CHANNEL_ID],
    kind: 'read',
  },
  {
    tool: 'get_ports_in_use',
    permission: 'channels.read',
    title: 'Listener ports in use',
    description: 'Every listener port channels currently hold (GET /channels/portsInUse).',
    method: 'GET',
    path: '/channels/portsInUse',
    params: [],
    kind: 'read',
  },
  {
    tool: 'get_channel_summaries',
    permission: 'channels.read',
    title: 'Channel change summaries',
    description:
      'Which channels changed relative to a cached map of channel id → revision ' +
      "(POST /channels/_getSummary) — the Administrator's incremental refresh.",
    method: 'POST',
    path: '/channels/_getSummary',
    params: [q('ignoreNewChannels', 'boolean', 'Leave out channels the cache never saw.')],
    body: xml(
      'cachedChannels',
      'An XML map of channel id → ChannelHeader, as the Administrator caches it.',
      false
    ),
    kind: 'read',
  },
  {
    tool: 'set_channels_enabled',
    permission: 'channels.edit',
    title: 'Enable or disable several channels',
    description: 'Set the enabled flag on many channels at once (POST /channels/_setEnabled).',
    method: 'POST',
    path: '/channels/_setEnabled',
    params: [],
    body: {
      kind: 'form',
      fields: [
        q('channelId', 'string[]', 'The channel ids to change.', true),
        q('enabled', 'boolean', 'true to enable, false to disable.', true),
      ],
    },
    kind: 'act',
  },
  {
    tool: 'set_channels_initial_state',
    permission: 'channels.edit',
    title: 'Set the deploy-time state of several channels',
    description:
      'Set the initial state (what a channel does when deployed) on many channels (POST /channels/_setInitialState).',
    method: 'POST',
    path: '/channels/_setInitialState',
    params: [],
    body: {
      kind: 'form',
      fields: [
        q('channelId', 'string[]', 'The channel ids to change.', true),
        q(
          'initialState',
          { enum: ['STARTED', 'STOPPED', 'PAUSED'] },
          'The state to take when deployed.',
          true
        ),
      ],
    },
    kind: 'act',
  },
  {
    tool: 'delete_channels',
    permission: 'channels.delete',
    title: 'Delete several channels',
    description:
      'Remove several channel definitions and their message stores (DELETE /channels?channelId=…). Permanent.',
    method: 'DELETE',
    path: '/channels',
    params: [q('channelId', 'string[]', 'The channel ids to delete.', true)],
    kind: 'destructive',
  },
  {
    tool: 'get_initial_channel_statuses',
    permission: 'channels.read',
    title: 'First page of dashboard statuses',
    description:
      "A partial dashboard status list plus the ids still to fetch — the Administrator's " +
      'initial dashboard load (GET /channels/statuses/initial).',
    method: 'GET',
    path: '/channels/statuses/initial',
    params: [
      q('fetchSize', 'int', 'How many statuses to return in this page.'),
      q('filter', 'string', 'Name filter applied server-side.'),
    ],
    kind: 'read',
  },
  // ---------------------------------------------------------------- messages
  {
    tool: 'process_raw_message',
    permission: 'messages.send',
    title: 'Process a RawMessage object',
    description:
      'Process a new message through a channel from a RawMessage XML document — content plus ' +
      'destination metadata ids and source map in one object (POST /channels/{channelId}/messagesWithObj). ' +
      'mirth_send_message is the simpler form.',
    method: 'POST',
    path: '/channels/{channelId}/messagesWithObj',
    params: [CHANNEL_ID],
    body: xml(
      'rawMessage',
      'A <rawMessage> document (rawData, destinationMetaDataIds, sourceMap).'
    ),
    kind: 'act',
    accept: 'text/plain',
  },
  {
    tool: 'get_message_attachments',
    permission: 'messages.read',
    title: 'Attachments of a message',
    description:
      'The attachments stored with one message, optionally with their content (GET /channels/{channelId}/messages/{messageId}/attachments).',
    method: 'GET',
    path: '/channels/{channelId}/messages/{messageId}/attachments',
    params: [
      CHANNEL_ID,
      MESSAGE_ID,
      q('includeContent', 'boolean', 'Return the attachment bytes (base64) too.'),
    ],
    kind: 'read',
  },
  {
    tool: 'get_message_attachment',
    permission: 'messages.read',
    title: 'One attachment of a message',
    description:
      'One attachment by id, content included (GET /channels/{channelId}/messages/{messageId}/attachments/{attachmentId}).',
    method: 'GET',
    path: '/channels/{channelId}/messages/{messageId}/attachments/{attachmentId}',
    params: [
      CHANNEL_ID,
      MESSAGE_ID,
      id('attachmentId', 'The attachment id (from mirth_get_message_attachments).'),
    ],
    kind: 'read',
  },
  {
    tool: 'get_dicom_message',
    permission: 'messages.read',
    title: 'Reattached DICOM message',
    description:
      'Given a ConnectorMessage XML document, reattach its DICOM attachment data and return ' +
      'the raw base64 message (POST /channels/{channelId}/messages/{messageId}/_getDICOMMessage).',
    method: 'POST',
    path: '/channels/{channelId}/messages/{messageId}/_getDICOMMessage',
    params: [CHANNEL_ID, MESSAGE_ID],
    body: xml(
      'message',
      'The <connectorMessage> document (from mirth_get_message via the XML form).'
    ),
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'get_max_message_id',
    permission: 'messages.read',
    title: 'Highest message id of a channel',
    description:
      "The maximum message id in a channel's store (GET /channels/{channelId}/messages/maxMessageId).",
    method: 'GET',
    path: '/channels/{channelId}/messages/maxMessageId',
    params: [CHANNEL_ID],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'delete_message',
    permission: 'messages.delete',
    title: 'Delete one message',
    description:
      'Remove a single message, or one connector message of it, from the store (DELETE /channels/{channelId}/messages/{messageId}). Permanent.',
    method: 'DELETE',
    path: '/channels/{channelId}/messages/{messageId}',
    params: [
      CHANNEL_ID,
      MESSAGE_ID,
      q('metaDataId', 'int', 'Only this connector message (0 = source).'),
      q('patientId', 'string', 'Patient id, for the PHI audit event.'),
    ],
    kind: 'destructive',
  },
  {
    tool: 'remove_all_messages_for_channels',
    permission: 'messages.delete',
    title: 'Purge the message stores of several channels',
    description:
      'Remove every message of several channels at once (DELETE /channels/_removeAllMessages). Permanent.',
    method: 'DELETE',
    path: '/channels/_removeAllMessages',
    params: [
      q('channelId', 'string[]', 'The channel ids to purge.', true),
      q('restartRunningChannels', 'boolean', 'Stop and restart running channels around the purge.'),
      q('clearStatistics', 'boolean', "Also reset the channels' statistics."),
    ],
    kind: 'destructive',
  },
  {
    tool: 'import_message',
    permission: 'messages.send',
    title: 'Import a message into the store',
    description:
      "Insert a Message XML document into a channel's store without processing it " +
      '(POST /channels/{channelId}/messages/_import) — restoring an exported message.',
    method: 'POST',
    path: '/channels/{channelId}/messages/_import',
    params: [CHANNEL_ID],
    body: xml('message', 'A <message> document as mirth_export_messages writes them.'),
    kind: 'act',
  },
  {
    tool: 'import_messages_from_path',
    permission: 'messages.send',
    title: 'Import messages from a server path',
    description:
      'Import every exported message under a path THE MIRTH SERVER can read, without processing ' +
      '(POST /channels/{channelId}/messages/_importFromPath).',
    method: 'POST',
    path: '/channels/{channelId}/messages/_importFromPath',
    params: [CHANNEL_ID, q('includeSubfolders', 'boolean', 'Descend into subfolders.')],
    body: {
      kind: 'text',
      name: 'path',
      description: 'A file or directory path on the Mirth server.',
      required: true,
    },
    kind: 'act',
  },
  {
    tool: 'export_messages',
    permission: 'messages.send',
    title: 'Export messages to a server directory',
    description:
      'Write the messages matching a filter into a directory THE MIRTH SERVER can write ' +
      '(POST /channels/{channelId}/messages/_export).',
    method: 'POST',
    path: '/channels/{channelId}/messages/_export',
    params: [
      CHANNEL_ID,
      ...MESSAGE_FILTER,
      q('pageSize', 'int', 'Messages per export page.'),
      q(
        'contentType',
        {
          enum: [
            'RAW',
            'PROCESSED_RAW',
            'TRANSFORMED',
            'ENCODED',
            'SENT',
            'RESPONSE',
            'RESPONSE_TRANSFORMED',
            'PROCESSED_RESPONSE',
          ],
        },
        'Which content to export; omit for the whole message.'
      ),
      q('destinationContent', 'boolean', 'Export destination content rather than source.'),
      q('encrypt', 'boolean', 'Encrypt the exported content.'),
      q('includeAttachments', 'boolean', 'Include attachments.'),
      q('baseFolder', 'string', 'The base folder on the server.', true),
      q('rootFolder', 'string', 'The root folder under baseFolder.', true),
      q('filePattern', 'string', 'The file name pattern (e.g. "${message.messageId}.xml").', true),
      q('archiveFileName', 'string', 'An archive file name, to zip the export.'),
      q('archiveFormat', 'string', 'The archive format (zip, tar).'),
      q('compressFormat', 'string', 'The compression format (gz, bz2).'),
      q('password', 'string', 'Archive password.'),
      q('encryptionType', 'string', 'Archive encryption type.'),
    ],
    kind: 'act',
    accept: 'text/plain',
  },
  {
    tool: 'export_message_attachment',
    permission: 'messages.send',
    title: 'Export one attachment to a server file',
    description:
      'Write one attachment to a file path THE MIRTH SERVER can write (POST /channels/{channelId}/messages/{messageId}/attachments/{attachmentId}/_export).',
    method: 'POST',
    path: '/channels/{channelId}/messages/{messageId}/attachments/{attachmentId}/_export',
    params: [
      CHANNEL_ID,
      MESSAGE_ID,
      id('attachmentId', 'The attachment id.'),
      q('binary', 'boolean', 'Decode base64 and write the raw bytes.'),
    ],
    body: {
      kind: 'text',
      name: 'filePath',
      description: 'The destination file path on the Mirth server.',
      required: true,
    },
    kind: 'act',
  },
  {
    tool: 'audit_accessed_phi_message',
    permission: 'messages.read',
    title: 'Audit: a PHI message was viewed',
    description:
      "Record in Mirth's event log that the user viewed a message containing PHI (POST /channels/_auditAccessedPHIMessage).",
    method: 'POST',
    path: '/channels/_auditAccessedPHIMessage',
    params: [q('auditMessageAttributesMap', 'string[]', 'Attribute entries as "key=value".')],
    kind: 'act',
  },
  {
    tool: 'audit_queried_phi_messages',
    permission: 'messages.read',
    title: 'Audit: PHI messages were queried',
    description:
      "Record in Mirth's event log that the user queried a message panel containing PHI (POST /channels/_auditQueriedPHIMessage).",
    method: 'POST',
    path: '/channels/_auditQueriedPHIMessage',
    params: [q('auditMessageAttributesMap', 'string[]', 'Attribute entries as "key=value".')],
    kind: 'act',
  },
  {
    tool: 'audit_export_messages',
    permission: 'messages.read',
    title: 'Audit: messages were exported',
    description:
      "Record in Mirth's event log that the user exported messages (POST /channels/_auditExportMessages).",
    method: 'POST',
    path: '/channels/_auditExportMessages',
    params: [q('auditMessageAttributesMap', 'string[]', 'Attribute entries as "key=value".')],
    kind: 'act',
  },
  {
    tool: 'audit_export_messages_success',
    permission: 'messages.read',
    title: 'Audit: a message export succeeded',
    description:
      "Record in Mirth's event log that a message export completed (POST /channels/_auditExportMessagesSuccess).",
    method: 'POST',
    path: '/channels/_auditExportMessagesSuccess',
    params: [q('auditMessageAttributesMap', 'string[]', 'Attribute entries as "key=value".')],
    kind: 'act',
  },
  // ---------------------------------------------------------------- statistics
  {
    tool: 'clear_channel_statistics',
    permission: 'messages.delete',
    title: 'Clear statistics of chosen channels or connectors',
    description:
      'Reset chosen counters (received / filtered / sent / error) for the channels and ' +
      'connectors named in an XML map (POST /channels/_clearStatistics). Irreversible.',
    method: 'POST',
    path: '/channels/_clearStatistics',
    params: [
      q('received', 'boolean', 'Reset the received counter.'),
      q('filtered', 'boolean', 'Reset the filtered counter.'),
      q('sent', 'boolean', 'Reset the sent counter.'),
      q('error', 'boolean', 'Reset the error counter.'),
    ],
    body: xml(
      'channelConnectorMap',
      'An XML map of channel id → list of connector metadata ids (null for the whole channel).'
    ),
    kind: 'destructive',
  },
  {
    tool: 'clear_all_statistics',
    permission: 'messages.delete',
    title: 'Clear every statistic on the server',
    description:
      'Reset all statistics, lifetime counters included, for every channel and connector (POST /channels/_clearAllStatistics). Irreversible.',
    method: 'POST',
    path: '/channels/_clearAllStatistics',
    params: [],
    kind: 'destructive',
  },
  // ---------------------------------------------------------------- channel groups
  {
    tool: 'bulk_update_channel_groups',
    permission: 'channels.edit',
    title: 'Replace channel groups',
    description:
      'Update every channel group in one request — the groups to keep or change, and the ' +
      'ids to remove (POST /channelgroups/_bulkUpdate).',
    method: 'POST',
    path: '/channelgroups/_bulkUpdate',
    params: [q('override', 'boolean', 'Apply even if a group changed since it was read.')],
    body: {
      kind: 'multipart',
      parts: [
        {
          name: 'channelGroups',
          description: 'An XML <set> of <channelGroup> documents.',
          required: true,
        },
        {
          name: 'removedChannelGroupIds',
          description: 'An XML <set> of <string> group ids to remove.',
        },
      ],
    },
    kind: 'destructive',
  },
  // ---------------------------------------------------------------- server / configuration
  {
    tool: 'get_server_id',
    permission: 'server.read',
    title: 'Server id',
    description: 'The server id (GET /server/id).',
    method: 'GET',
    path: '/server/id',
    params: [],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'get_server_version',
    permission: 'server.read',
    title: 'Server version',
    description: 'The Mirth Connect version (GET /server/version).',
    method: 'GET',
    path: '/server/version',
    params: [],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'get_server_build_date',
    permission: 'server.read',
    title: 'Server build date',
    description: 'The build date of the server (GET /server/buildDate).',
    method: 'GET',
    path: '/server/buildDate',
    params: [],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'get_server_status',
    permission: 'server.read',
    title: 'Server status code',
    description:
      'The status of the server: 0 running, 1 starting, 2 stopping (GET /server/status).',
    method: 'GET',
    path: '/server/status',
    params: [],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'get_server_timezone',
    permission: 'server.read',
    title: 'Server time zone',
    description: 'The time zone of the server (GET /server/timezone).',
    method: 'GET',
    path: '/server/timezone',
    params: [],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'get_server_time',
    permission: 'server.read',
    title: 'Server time',
    description: 'The current time on the server (GET /server/time).',
    method: 'GET',
    path: '/server/time',
    params: [],
    kind: 'read',
  },
  {
    tool: 'get_server_jvm',
    permission: 'server.read',
    title: 'Server JVM',
    description: 'The name of the JVM running Mirth (GET /server/jvm).',
    method: 'GET',
    path: '/server/jvm',
    params: [],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'get_server_configuration',
    permission: 'server.read',
    title: 'Whole server configuration (backup)',
    description:
      'The ServerConfiguration document — every channel, alert, code template, group, ' +
      "setting and script — as the Administrator's backup exports it (GET /server/configuration).",
    method: 'GET',
    path: '/server/configuration',
    params: [
      q(
        'initialState',
        { enum: ['STARTED', 'STOPPED', 'PAUSED'] },
        "Override every channel's initial state in the export."
      ),
      q('pollingOnly', 'boolean', 'Only channels with a polling source connector.'),
      q('disableAlerts', 'boolean', 'Mark every alert disabled in the export.'),
    ],
    kind: 'read',
    accept: 'application/xml',
  },
  {
    tool: 'restore_server_configuration',
    permission: 'server.restore',
    title: 'Restore a whole server configuration',
    description:
      'Replace every channel, alert, code template, group, setting and script with a ' +
      "ServerConfiguration document (PUT /server/configuration) — the Administrator's restore. " +
      'Everything not in the document is removed.',
    method: 'PUT',
    path: '/server/configuration',
    params: [
      q('deploy', 'boolean', 'Deploy the restored channels afterwards.'),
      q('overwriteConfigMap', 'boolean', 'Replace the configuration map too.'),
    ],
    body: xml(
      'serverConfiguration',
      'The <serverConfiguration> document (from mirth_get_server_configuration).'
    ),
    kind: 'destructive',
  },
  {
    tool: 'get_charsets',
    permission: 'server.read',
    title: 'Supported charsets',
    description: 'The charset encodings the server supports (GET /server/charsets).',
    method: 'GET',
    path: '/server/charsets',
    params: [],
    kind: 'read',
  },
  {
    tool: 'update_server_settings',
    permission: 'server.configure',
    title: 'Update server settings',
    description:
      'Replace the server settings with a ServerSettings document (PUT /server/settings). Read them first with mirth_get_server_settings.',
    method: 'PUT',
    path: '/server/settings',
    params: [],
    body: xml('settings', 'The <serverSettings> document.'),
    kind: 'act',
  },
  {
    tool: 'get_public_settings',
    permission: 'server.read',
    title: 'Public server settings',
    description: 'The settings available to every user (GET /server/publicSettings).',
    method: 'GET',
    path: '/server/publicSettings',
    params: [],
    kind: 'read',
  },
  {
    tool: 'get_server_property',
    permission: 'server.read',
    title: 'One configuration property',
    description:
      'A property from the CONFIGURATION table by group and name (GET /server/property).',
    method: 'GET',
    path: '/server/property',
    params: [
      q('group', 'string', 'The property group (category).', true),
      q('name', 'string', 'The property name.', true),
    ],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'get_encryption_settings',
    permission: 'server.read',
    title: 'Encryption settings',
    description: "The server's encryption settings (GET /server/encryption).",
    method: 'GET',
    path: '/server/encryption',
    params: [],
    kind: 'read',
  },
  {
    tool: 'send_test_email',
    permission: 'server.configure',
    title: 'Send a test email',
    description: 'Send a test email with the SMTP settings given (POST /server/_testEmail).',
    method: 'POST',
    path: '/server/_testEmail',
    params: [],
    body: xml(
      'properties',
      'An XML <properties> map: port, encryption, host, timeout, authentication, username, password, toAddress, fromAddress.'
    ),
    kind: 'act',
  },
  {
    tool: 'get_update_settings',
    permission: 'server.read',
    title: 'Update settings',
    description: 'The update-notification settings (GET /server/updateSettings).',
    method: 'GET',
    path: '/server/updateSettings',
    params: [],
    kind: 'read',
  },
  {
    tool: 'update_update_settings',
    permission: 'server.configure',
    title: 'Change update settings',
    description: 'Replace the update-notification settings (PUT /server/updateSettings).',
    method: 'PUT',
    path: '/server/updateSettings',
    params: [],
    body: xml('settings', 'The <updateSettings> document.'),
    kind: 'act',
  },
  {
    tool: 'get_license_info',
    permission: 'server.read',
    title: 'License info',
    description: 'License expiration and related information (GET /server/licenseInfo).',
    method: 'GET',
    path: '/server/licenseInfo',
    params: [],
    kind: 'read',
  },
  {
    tool: 'generate_guid',
    permission: 'server.read',
    title: 'Generate a GUID',
    description:
      'A new globally unique id from the server, for a new channel or code template (POST /server/_generateGUID).',
    method: 'POST',
    path: '/server/_generateGUID',
    params: [],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'get_database_drivers',
    permission: 'server.read',
    title: 'Database drivers',
    description: 'The JDBC driver list channels can choose from (GET /server/databaseDrivers).',
    method: 'GET',
    path: '/server/databaseDrivers',
    params: [],
    kind: 'read',
  },
  {
    tool: 'update_database_drivers',
    permission: 'server.configure',
    title: 'Replace the database driver list',
    description: 'Replace the JDBC driver list (PUT /server/databaseDrivers).',
    method: 'PUT',
    path: '/server/databaseDrivers',
    params: [],
    body: xml('drivers', 'An XML <list> of <driverInfo> documents.'),
    kind: 'act',
  },
  {
    tool: 'get_password_requirements',
    permission: 'server.read',
    title: 'Password requirements',
    description: 'The password policy for Mirth users (GET /server/passwordRequirements).',
    method: 'GET',
    path: '/server/passwordRequirements',
    params: [],
    kind: 'read',
  },
  {
    tool: 'get_resources',
    permission: 'server.read',
    title: 'Resources (library directories)',
    description:
      'The resource definitions — custom library directories channels load (GET /server/resources).',
    method: 'GET',
    path: '/server/resources',
    params: [],
    kind: 'read',
  },
  {
    tool: 'update_resources',
    permission: 'server.configure',
    title: 'Replace the resources',
    description: 'Replace every resource definition (PUT /server/resources).',
    method: 'PUT',
    path: '/server/resources',
    params: [],
    body: xml('resources', 'An XML <list> of resource property documents.'),
    kind: 'act',
  },
  {
    tool: 'reload_resource',
    permission: 'server.configure',
    title: 'Reload a resource',
    description:
      'Reload one resource and every library it carries (POST /server/resources/{resourceId}/_reload).',
    method: 'POST',
    path: '/server/resources/{resourceId}/_reload',
    params: [id('resourceId', 'The resource id (from mirth_get_resources).')],
    kind: 'act',
  },
  {
    tool: 'get_channel_dependencies',
    permission: 'channels.read',
    title: 'Channel dependencies',
    description:
      'The deploy/undeploy ordering dependencies between channels (GET /server/channelDependencies).',
    method: 'GET',
    path: '/server/channelDependencies',
    params: [],
    kind: 'read',
  },
  {
    tool: 'update_channel_dependencies',
    permission: 'channels.edit',
    title: 'Replace channel dependencies',
    description: 'Replace every channel dependency (PUT /server/channelDependencies).',
    method: 'PUT',
    path: '/server/channelDependencies',
    params: [],
    body: xml('dependencies', 'An XML <set> of <channelDependency> documents.'),
    kind: 'act',
  },
  {
    tool: 'get_channel_metadata',
    permission: 'channels.read',
    title: 'Channel metadata',
    description:
      'Per-channel metadata: enabled flag, last modified, pruning settings (GET /server/channelMetadata).',
    method: 'GET',
    path: '/server/channelMetadata',
    params: [],
    kind: 'read',
  },
  {
    tool: 'update_channel_metadata',
    permission: 'channels.edit',
    title: 'Replace channel metadata',
    description: 'Replace the per-channel metadata map (PUT /server/channelMetadata).',
    method: 'PUT',
    path: '/server/channelMetadata',
    params: [],
    body: xml('metadata', 'An XML map of channel id → <channelMetadata>.'),
    kind: 'act',
  },
  {
    tool: 'get_protocols_and_cipher_suites',
    permission: 'server.read',
    title: 'TLS protocols and cipher suites',
    description:
      'The supported and enabled TLS protocols and cipher suites (GET /server/protocolsAndCipherSuites).',
    method: 'GET',
    path: '/server/protocolsAndCipherSuites',
    params: [],
    kind: 'read',
  },
  {
    tool: 'update_channel_tags',
    permission: 'channels.edit',
    title: 'Replace channel tags',
    description:
      'Replace every channel tag (PUT /server/channelTags). Read them first with mirth_list_channel_groups.',
    method: 'PUT',
    path: '/server/channelTags',
    params: [],
    body: xml('channelTags', 'An XML <set> of <channelTag> documents.'),
    kind: 'act',
  },
  {
    tool: 'get_rhino_language_version',
    permission: 'server.read',
    title: 'Rhino language version',
    description:
      'The JavaScript language version the Rhino engine uses (GET /server/rhinoLanguageVersion).',
    method: 'GET',
    path: '/server/rhinoLanguageVersion',
    params: [],
    kind: 'read',
    accept: 'text/plain',
  },
  // ---------------------------------------------------------------- users
  {
    tool: 'create_user',
    permission: 'users.edit',
    title: 'Create a user',
    description:
      'Create a Mirth user (POST /users). Set the password afterwards with mirth_set_user_password.',
    method: 'POST',
    path: '/users',
    params: [],
    body: xml(
      'user',
      'A <user> document (username, firstName, lastName, email, organization, description, phoneNumber, industry).'
    ),
    kind: 'act',
  },
  {
    tool: 'get_user',
    permission: 'users.read',
    title: 'One user',
    description: 'A user by id or username (GET /users/{userIdOrName}).',
    method: 'GET',
    path: '/users/{userIdOrName}',
    params: [id('userIdOrName', 'The user id or username.')],
    kind: 'read',
  },
  {
    tool: 'get_current_user',
    permission: 'users.read',
    title: 'The connected user',
    description: 'The Mirth user this connection is logged in as (GET /users/current).',
    method: 'GET',
    path: '/users/current',
    params: [],
    kind: 'read',
  },
  {
    tool: 'update_user',
    permission: 'users.edit',
    title: 'Update a user',
    description: "Replace a user's details (PUT /users/{userId}).",
    method: 'PUT',
    path: '/users/{userId}',
    params: [
      { name: 'userId', in: 'path', type: 'int', required: true, description: 'The user id.' },
    ],
    body: xml('user', 'The full <user> document (from mirth_get_user), edited.'),
    kind: 'act',
  },
  {
    tool: 'delete_user',
    permission: 'users.delete',
    title: 'Delete a user',
    description: 'Remove a Mirth user (DELETE /users/{userId}). Permanent.',
    method: 'DELETE',
    path: '/users/{userId}',
    params: [
      { name: 'userId', in: 'path', type: 'int', required: true, description: 'The user id.' },
    ],
    kind: 'destructive',
  },
  {
    tool: 'check_password',
    permission: 'users.read',
    title: 'Check a password against the policy',
    description:
      "Whether a candidate password satisfies the server's password requirements (POST /users/_checkPassword).",
    method: 'POST',
    path: '/users/_checkPassword',
    params: [],
    body: {
      kind: 'text',
      name: 'password',
      description: 'The candidate password.',
      required: true,
    },
    kind: 'read',
  },
  {
    tool: 'set_user_password',
    permission: 'users.edit',
    title: "Set a user's password",
    description: "Replace a user's password (PUT /users/{userId}/password).",
    method: 'PUT',
    path: '/users/{userId}/password',
    params: [
      { name: 'userId', in: 'path', type: 'int', required: true, description: 'The user id.' },
    ],
    body: { kind: 'text', name: 'password', description: 'The new password.', required: true },
    kind: 'destructive',
  },
  {
    tool: 'is_user_logged_in',
    permission: 'users.read',
    title: 'Whether a user is logged in',
    description:
      'true if the user currently holds a session on the server (GET /users/{userId}/loggedIn).',
    method: 'GET',
    path: '/users/{userId}/loggedIn',
    params: [
      { name: 'userId', in: 'path', type: 'int', required: true, description: 'The user id.' },
    ],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'get_user_preferences',
    permission: 'users.read',
    title: "A user's preferences",
    description:
      "A user's preference map, optionally only the names given (GET /users/{userId}/preferences).",
    method: 'GET',
    path: '/users/{userId}/preferences',
    params: [
      { name: 'userId', in: 'path', type: 'int', required: true, description: 'The user id.' },
      q('name', 'string[]', 'Only these preference names.'),
    ],
    kind: 'read',
  },
  {
    tool: 'get_user_preference',
    permission: 'users.read',
    title: 'One user preference',
    description: 'One preference value of a user (GET /users/{userId}/preferences/{name}).',
    method: 'GET',
    path: '/users/{userId}/preferences/{name}',
    params: [
      { name: 'userId', in: 'path', type: 'int', required: true, description: 'The user id.' },
      id('name', 'The preference name.'),
    ],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'update_user_preferences',
    permission: 'users.edit',
    title: 'Set several user preferences',
    description: 'Replace several preferences of a user (PUT /users/{userId}/preferences).',
    method: 'PUT',
    path: '/users/{userId}/preferences',
    params: [
      { name: 'userId', in: 'path', type: 'int', required: true, description: 'The user id.' },
    ],
    body: xml('properties', 'An XML <properties> map of name → value.'),
    kind: 'act',
  },
  {
    tool: 'set_user_preference',
    permission: 'users.edit',
    title: 'Set one user preference',
    description: 'Set one preference of a user (PUT /users/{userId}/preferences/{name}).',
    method: 'PUT',
    path: '/users/{userId}/preferences/{name}',
    params: [
      { name: 'userId', in: 'path', type: 'int', required: true, description: 'The user id.' },
      id('name', 'The preference name.'),
    ],
    body: { kind: 'text', name: 'value', description: 'The preference value.', required: true },
    kind: 'act',
  },
  {
    tool: 'acknowledge_user_notification',
    permission: 'users.edit',
    title: 'Acknowledge a user notification',
    description:
      'Mark the server notifications acknowledged for a user (POST /users/{userId}/notificationAcknowledged).',
    method: 'POST',
    path: '/users/{userId}/notificationAcknowledged',
    params: [
      { name: 'userId', in: 'path', type: 'int', required: true, description: 'The user id.' },
    ],
    kind: 'act',
  },
  // ---------------------------------------------------------------- events
  {
    tool: 'get_max_event_id',
    permission: 'events.read',
    title: 'Highest event id',
    description: 'The maximum event id in the database (GET /events/maxEventId).',
    method: 'GET',
    path: '/events/maxEventId',
    params: [],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'get_event',
    permission: 'events.read',
    title: 'One event',
    description: 'One server event by id (GET /events/{eventId}).',
    method: 'GET',
    path: '/events/{eventId}',
    params: [
      { name: 'eventId', in: 'path', type: 'int', required: true, description: 'The event id.' },
    ],
    kind: 'read',
  },
  {
    tool: 'count_events',
    permission: 'events.read',
    title: 'Count events matching a filter',
    description: 'How many server events match the filter (GET /events/count).',
    method: 'GET',
    path: '/events/count',
    params: EVENT_FILTER,
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'export_events',
    permission: 'events.read',
    title: 'Export all events',
    description:
      'Write every event to the application data directory on the server and return the file path (POST /events/_export).',
    method: 'POST',
    path: '/events/_export',
    params: [],
    kind: 'act',
    accept: 'text/plain',
  },
  // ---------------------------------------------------------------- alerts
  {
    tool: 'create_alert',
    permission: 'alerts.edit',
    title: 'Create an alert',
    description: 'Create an alert from an AlertModel document (POST /alerts).',
    method: 'POST',
    path: '/alerts',
    params: [],
    body: xml(
      'alertModel',
      "An <alertModel> document (from mirth_get_alert in XML form, or the Administrator's export)."
    ),
    kind: 'act',
  },
  {
    tool: 'get_alerts',
    permission: 'alerts.read',
    title: 'Alert definitions',
    description: 'The full definitions of all alerts, or of the ids given (GET /alerts).',
    method: 'GET',
    path: '/alerts',
    params: [q('alertId', 'string[]', 'Only these alert ids; omit for all.')],
    kind: 'read',
  },
  {
    tool: 'get_alert_info',
    permission: 'alerts.read',
    title: 'Alert editor info for one alert',
    description:
      'The alert model, protocol options and changed channel summaries the editor needs (POST /alerts/{alertId}/_getInfo).',
    method: 'POST',
    path: '/alerts/{alertId}/_getInfo',
    params: [id('alertId', 'The alert id.')],
    body: xml(
      'cachedChannels',
      'An XML map of channel id → ChannelHeader the caller has cached; empty for none.',
      false
    ),
    kind: 'read',
  },
  {
    tool: 'get_alerts_info',
    permission: 'alerts.read',
    title: 'Alert editor info (no alert)',
    description:
      'Protocol options and changed channel summaries for a new alert (POST /alerts/_getInfo).',
    method: 'POST',
    path: '/alerts/_getInfo',
    params: [],
    body: xml(
      'cachedChannels',
      'An XML map of channel id → ChannelHeader the caller has cached; empty for none.',
      false
    ),
    kind: 'read',
  },
  {
    tool: 'get_alert_options',
    permission: 'alerts.read',
    title: 'Alert protocol options',
    description:
      'The alert protocol options (email, channel, …) available on the server (GET /alerts/options).',
    method: 'GET',
    path: '/alerts/options',
    params: [],
    kind: 'read',
  },
  {
    tool: 'update_alert',
    permission: 'alerts.edit',
    title: 'Update an alert',
    description: 'Replace an alert with an AlertModel document (PUT /alerts/{alertId}).',
    method: 'PUT',
    path: '/alerts/{alertId}',
    params: [id('alertId', 'The alert id.')],
    body: xml('alertModel', 'The full <alertModel> document, edited.'),
    kind: 'act',
  },
  {
    tool: 'delete_alert',
    permission: 'alerts.delete',
    title: 'Delete an alert',
    description: 'Remove an alert (DELETE /alerts/{alertId}). Permanent.',
    method: 'DELETE',
    path: '/alerts/{alertId}',
    params: [id('alertId', 'The alert id.')],
    kind: 'destructive',
  },
  // ---------------------------------------------------------------- code templates
  {
    tool: 'get_code_template_library',
    permission: 'code_templates.read',
    title: 'One code template library',
    description:
      'One library, optionally with its templates (GET /codeTemplateLibraries/{libraryId}).',
    method: 'GET',
    path: '/codeTemplateLibraries/{libraryId}',
    params: [
      id('libraryId', 'The library id.'),
      q('includeCodeTemplates', 'boolean', 'Include the templates themselves.'),
    ],
    kind: 'read',
  },
  {
    tool: 'update_code_template_libraries',
    permission: 'code_templates.edit',
    title: 'Replace all code template libraries',
    description: 'Replace every code template library (PUT /codeTemplateLibraries).',
    method: 'PUT',
    path: '/codeTemplateLibraries',
    params: [q('override', 'boolean', 'Apply even if a library changed since it was read.')],
    body: xml('libraries', 'An XML <list> of <codeTemplateLibrary> documents.'),
    kind: 'act',
    accept: 'text/plain',
  },
  {
    tool: 'get_code_templates',
    permission: 'code_templates.read',
    title: 'Code templates',
    description: 'All code templates, or the ids given, with their code (GET /codeTemplates).',
    method: 'GET',
    path: '/codeTemplates',
    params: [q('codeTemplateId', 'string[]', 'Only these template ids; omit for all.')],
    kind: 'read',
  },
  {
    tool: 'get_code_template_summaries',
    permission: 'code_templates.read',
    title: 'Code template change summaries',
    description:
      'Which templates changed relative to the revisions given (POST /codeTemplates/_getSummary).',
    method: 'POST',
    path: '/codeTemplates/_getSummary',
    params: [],
    body: xml('clientRevisions', 'An XML map of template id → revision the caller holds.'),
    kind: 'read',
  },
  {
    tool: 'update_code_template',
    permission: 'code_templates.edit',
    title: 'Create or update a code template',
    description:
      'Save one code template (PUT /codeTemplates/{codeTemplateId}). The id in the path must match the document.',
    method: 'PUT',
    path: '/codeTemplates/{codeTemplateId}',
    params: [
      id('codeTemplateId', 'The template id (mirth_generate_guid for a new one).'),
      q('override', 'boolean', 'Apply even if the template changed since it was read.'),
    ],
    body: xml('codeTemplate', 'The <codeTemplate> document.'),
    kind: 'act',
    accept: 'text/plain',
  },
  {
    tool: 'delete_code_template',
    permission: 'code_templates.delete',
    title: 'Delete a code template',
    description: 'Remove a code template (DELETE /codeTemplates/{codeTemplateId}). Permanent.',
    method: 'DELETE',
    path: '/codeTemplates/{codeTemplateId}',
    params: [id('codeTemplateId', 'The template id.')],
    kind: 'destructive',
  },
  {
    tool: 'bulk_update_code_templates',
    permission: 'code_templates.edit',
    title: 'Update libraries and templates in one request',
    description:
      'Replace the libraries, update chosen templates and remove others in a single request ' +
      '(POST /codeTemplateLibraries/_bulkUpdate).',
    method: 'POST',
    path: '/codeTemplateLibraries/_bulkUpdate',
    params: [q('override', 'boolean', 'Apply even if something changed since it was read.')],
    body: {
      kind: 'multipart',
      parts: [
        {
          name: 'libraries',
          description: 'An XML <list> of <codeTemplateLibrary> documents.',
          required: true,
        },
        {
          name: 'removedLibraryIds',
          description: 'An XML <set> of <string> library ids to remove.',
        },
        {
          name: 'updatedCodeTemplates',
          description: 'An XML <list> of <codeTemplate> documents to save.',
        },
        {
          name: 'removedCodeTemplateIds',
          description: 'An XML <set> of <string> template ids to remove.',
        },
      ],
    },
    kind: 'destructive',
  },
  // ---------------------------------------------------------------- extensions
  {
    tool: 'uninstall_extension',
    permission: 'server.restore',
    title: 'Uninstall an extension',
    description:
      'Uninstall an extension by its path; takes effect after a server restart (POST /extensions/_uninstall).',
    method: 'POST',
    path: '/extensions/_uninstall',
    params: [],
    body: {
      kind: 'text',
      name: 'extensionPath',
      description: "The extension's path, as mirth_get_extension reports it.",
      required: true,
    },
    kind: 'destructive',
  },
  {
    tool: 'get_extension',
    permission: 'server.read',
    title: 'One extension',
    description: 'The metadata of one extension by name (GET /extensions/{extensionName}).',
    method: 'GET',
    path: '/extensions/{extensionName}',
    params: [id('extensionName', 'The extension name (from mirth_list_extensions).')],
    kind: 'read',
  },
  {
    tool: 'is_extension_enabled',
    permission: 'server.read',
    title: 'Whether an extension is enabled',
    description: 'The enabled state of an extension (GET /extensions/{extensionName}/enabled).',
    method: 'GET',
    path: '/extensions/{extensionName}/enabled',
    params: [id('extensionName', 'The extension name.')],
    kind: 'read',
    accept: 'text/plain',
  },
  {
    tool: 'set_extension_enabled',
    permission: 'server.configure',
    title: 'Enable or disable an extension',
    description:
      'Enable or disable an extension; takes effect after a server restart (POST /extensions/{extensionName}/_setEnabled).',
    method: 'POST',
    path: '/extensions/{extensionName}/_setEnabled',
    params: [
      id('extensionName', 'The extension name.'),
      q('enabled', 'boolean', 'true to enable, false to disable.', true),
    ],
    kind: 'act',
  },
  {
    tool: 'get_extension_properties',
    permission: 'server.read',
    title: 'Properties of an extension',
    description:
      "An extension's stored properties, optionally only the keys given (GET /extensions/{extensionName}/properties).",
    method: 'GET',
    path: '/extensions/{extensionName}/properties',
    params: [
      id('extensionName', 'The extension name.'),
      q('propertyKeys', 'string[]', 'Only these property keys.'),
    ],
    kind: 'read',
  },
  {
    tool: 'update_extension_properties',
    permission: 'server.configure',
    title: 'Set properties of an extension',
    description:
      "Replace or merge an extension's properties (PUT /extensions/{extensionName}/properties).",
    method: 'PUT',
    path: '/extensions/{extensionName}/properties',
    params: [
      id('extensionName', 'The extension name.'),
      q(
        'mergeProperties',
        'boolean',
        'Merge into the stored properties instead of replacing them.'
      ),
    ],
    body: xml('properties', 'An XML <properties> map.'),
    kind: 'act',
  },
  // ---------------------------------------------------------------- system / database tasks / usage
  {
    tool: 'get_system_info',
    permission: 'server.read',
    title: 'System info',
    description: 'Information about the host system: OS, JVM, database (GET /system/info).',
    method: 'GET',
    path: '/system/info',
    params: [],
    kind: 'read',
  },
  {
    tool: 'get_system_stats',
    permission: 'server.read',
    title: 'System stats',
    description: 'CPU, memory and disk statistics of the host (GET /system/stats).',
    method: 'GET',
    path: '/system/stats',
    params: [],
    kind: 'read',
  },
  {
    tool: 'get_database_tasks',
    permission: 'server.read',
    title: 'Database tasks',
    description: 'The pending database maintenance tasks (GET /databaseTasks).',
    method: 'GET',
    path: '/databaseTasks',
    params: [],
    kind: 'read',
  },
  {
    tool: 'get_database_task',
    permission: 'server.read',
    title: 'One database task',
    description: 'One database maintenance task by id (GET /databaseTasks/{databaseTaskId}).',
    method: 'GET',
    path: '/databaseTasks/{databaseTaskId}',
    params: [id('databaseTaskId', 'The task id (from mirth_get_database_tasks).')],
    kind: 'read',
  },
  {
    tool: 'run_database_task',
    permission: 'server.restore',
    title: 'Run a database task',
    description:
      'Execute a database maintenance task — these alter the message database (POST /databaseTasks/{databaseTaskId}/_run).',
    method: 'POST',
    path: '/databaseTasks/{databaseTaskId}/_run',
    params: [id('databaseTaskId', 'The task id.')],
    kind: 'destructive',
    accept: 'text/plain',
  },
  {
    tool: 'cancel_database_task',
    permission: 'server.configure',
    title: 'Cancel a running database task',
    description:
      'Cancel a database maintenance task in progress (POST /databaseTasks/{databaseTaskId}/_cancel).',
    method: 'POST',
    path: '/databaseTasks/{databaseTaskId}/_cancel',
    params: [id('databaseTaskId', 'The task id.')],
    kind: 'act',
  },
  {
    tool: 'generate_usage_data',
    permission: 'server.read',
    title: 'Generate the usage document',
    description:
      'Build the usage-statistics document from client and server data (POST /usageData/_generate).',
    method: 'POST',
    path: '/usageData/_generate',
    params: [],
    body: xml('clientStats', 'An XML map of client-side statistics; empty for none.', false),
    kind: 'act',
    accept: 'text/plain',
  },
];

/** The `{name}` placeholders of a path template. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]);
}

/** Substitute path parameters, each encoded once. */
export function fillPath(path: string, values: Record<string, string | number>): string {
  return path.replace(/\{([A-Za-z]+)\}/g, (_whole, name: string) =>
    encodeURIComponent(String(values[name]))
  );
}
