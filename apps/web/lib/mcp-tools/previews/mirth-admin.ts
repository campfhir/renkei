/**
 * Preview cards for Mirth Connect's administration and message-handling
 * acts: server settings, users, alerts, code templates, extensions,
 * message import and export, and the audit entries a client records.
 * (The channel acts are in integrations.ts.)
 *
 * Most of these take a whole XML or JSON document as one string — the
 * server's settings, a user, an alert. The card shows the document as
 * written, in a block, because that is exactly what the tool will send;
 * summarising it would hide the part that matters.
 */

import type { Row } from '@/lib/mcp-widgets/src/act-card';
import type { Names, PreviewBuilder, PreviewSpec } from './card';
import { clip, count, record, ref, show, strings, text, yes } from './card';
import { labelOr, labelsOr } from './readable';

type Args = Record<string, unknown>;

const instance = (args: Args, names: Names) => {
  const name = labelOr(names, 'instance', args.instanceId, '');
  return name ? `Mirth Connect · ${name}` : 'Mirth Connect';
};

/** What a card calls a thing it looked up; never its id. */
/** "alert ADT errors", or "an alert" when there is no name to show. */
const titled = (names: Names, kind: string, noun: string, value: unknown) => {
  const name = labelOr(names, kind, value, '');
  return name ? `${noun} ${name}` : `a ${noun}`;
};
const channelOf = (args: Args, names: Names) =>
  labelOr(names, 'channel', args.channelId, 'The channel');
const userOf = (args: Args, names: Names) => labelOr(names, 'user', args.userId, 'The user');
const alertOf = (args: Args, names: Names) => labelOr(names, 'alert', args.alertId, 'The alert');
const templateOf = (args: Args, names: Names) =>
  labelOr(names, 'code_template', args.codeTemplateId, 'The code template');
const block = (label: string, value: unknown, max = 1500): Row => ({
  label,
  value: clip(show(value), max),
  block: true,
});

interface Change {
  verb: string;
  tone?: PreviewSpec['tone'];
  icon: PreviewSpec['icon'];
  title: string;
  subject: string;
  kind?: string;
  rows: Row[];
  notes?: string[];
  confirmLabel?: string;
}

function change(args: Args, names: Names, spec: Change): PreviewSpec {
  return {
    verb: spec.verb,
    ...(spec.tone ? { tone: spec.tone } : {}),
    icon: spec.icon,
    title: spec.title,
    subtitle: instance(args, names),
    confirmLabel: spec.confirmLabel ?? spec.title,
    body: {
      kind: 'change',
      subject: ref(spec.subject, spec.kind),
      rows: spec.rows,
      ...(spec.notes ? { notes: spec.notes } : {}),
    },
  };
}

const ids = (value: unknown) => strings(value);

function toggle(args: Args, names: Names, to: string, title: string): PreviewSpec {
  const channels = labelsOr(names, 'channel', args.channelId, 'A channel');
  return {
    verb: to,
    tone: to === 'Disabled' ? 'caution' : 'positive',
    icon: to === 'Disabled' ? 'stop' : 'check',
    title,
    subtitle: instance(args, names),
    confirmLabel: title,
    body: {
      kind: 'transition',
      query: channels.join('\n'),
      field: `${count(channels.length, 'channel')}`,
      to,
    },
  };
}

function filterRows(args: Args): Row[] {
  const skip = new Set([
    'instanceId',
    'channelId',
    'baseFolder',
    'rootFolder',
    'filePattern',
    'archiveFileName',
    'archiveFormat',
    'compressFormat',
    'password',
    'encryptionType',
    'encrypt',
    'includeAttachments',
    'pageSize',
    'contentType',
    'destinationContent',
  ]);
  return Object.entries(args)
    .filter(
      ([key, value]) => !skip.has(key) && value !== undefined && value !== null && value !== ''
    )
    .map(([label, value]) => ({ label, value: show(value) }));
}

function audit(title: string, what: string) {
  return (args: Args, names: Names): PreviewSpec =>
    change(args, names, {
      verb: 'Record',
      icon: 'flag',
      title,
      subject: 'Audit log',
      kind: 'Mirth',
      rows: Object.entries(record(args.auditMessageAttributesMap)).map(([label, value]) => ({
        label,
        value: show(value),
      })),
      notes: [`Adds an entry to Mirth’s audit log: ${what}. It cannot be removed afterwards.`],
    });
}

export const MIRTH_ADMIN_PREVIEWS: Record<string, PreviewBuilder> = {
  mirth_set_channels_enabled: (args, names) =>
    toggle(
      args,
      names,
      yes(args.enabled) ? 'Enabled' : 'Disabled',
      `${yes(args.enabled) ? 'Enable' : 'Disable'} ${count(ids(args.channelId).length, 'channel')}`
    ),

  mirth_set_channels_initial_state: (args, names) => ({
    verb: 'Set state',
    icon: 'gear',
    title: `Deploy ${count(ids(args.channelId).length, 'channel')} ${text(args.initialState).toLowerCase()}`,
    subtitle: instance(args, names),
    confirmLabel: 'Set initial state',
    body: {
      kind: 'transition',
      query: labelsOr(names, 'channel', args.channelId, 'A channel').join('\n'),
      field: 'State after each deploy',
      to: text(args.initialState),
    },
  }),

  mirth_process_raw_message: (args, names) =>
    change(args, names, {
      verb: 'Process',
      tone: 'caution',
      icon: 'play',
      title: 'Process a raw message',
      subject: channelOf(args, names),
      kind: 'Channel',
      rows: [block('Raw message', args.rawMessage)],
      notes: ['The channel handles it as if it had arrived: destinations act on it for real.'],
    }),

  mirth_import_message: (args, names) =>
    change(args, names, {
      verb: 'Import',
      icon: 'upload',
      title: 'Import a message into a channel',
      subject: channelOf(args, names),
      kind: 'Channel',
      rows: [block('Message', args.message)],
      notes: ['Stored as it is; it is not processed.'],
    }),

  mirth_import_messages_from_path: (args, names) =>
    change(args, names, {
      verb: 'Import',
      icon: 'upload',
      title: 'Import messages from a folder on the server',
      subject: channelOf(args, names),
      kind: 'Channel',
      rows: [
        { label: 'Server path', value: text(args.path) },
        { label: 'Subfolders', value: yes(args.includeSubfolders) ? 'Included' : 'Not included' },
      ],
      notes: ['Reads files from the Mirth server’s own disk.'],
    }),

  mirth_export_messages: (args, names) =>
    change(args, names, {
      verb: 'Export',
      tone: 'caution',
      icon: 'upload',
      title: 'Export messages to a folder on the server',
      subject: channelOf(args, names),
      kind: 'Channel',
      rows: [
        {
          label: 'Write to',
          value: `${text(args.baseFolder)}/${text(args.rootFolder)}/${text(args.filePattern)}`,
        },
        ...(text(args.archiveFileName)
          ? [
              {
                label: 'Archive',
                value: `${text(args.archiveFileName)} (${text(args.archiveFormat) || 'default format'})`,
              },
            ]
          : []),
        ...(yes(args.encrypt)
          ? [{ label: 'Encrypted', value: text(args.encryptionType) || 'Yes' }]
          : []),
        ...(yes(args.includeAttachments) ? [{ label: 'Attachments', value: 'Included' }] : []),
        ...(text(args.contentType) ? [{ label: 'Content', value: text(args.contentType) }] : []),
        ...filterRows(args),
      ],
      notes: ['Writes files on the Mirth server. Message content may include patient data.'],
    }),

  mirth_export_message_attachment: (args, names) =>
    change(args, names, {
      verb: 'Export',
      icon: 'upload',
      title: 'Export an attachment to a file on the server',
      subject: channelOf(args, names),
      kind: 'Channel',
      rows: [
        { label: 'Message', value: 'One message of this channel' },
        { label: 'Attachment', value: 'One of its attachments' },
        { label: 'Write to', value: text(args.filePath) },
        { label: 'As', value: yes(args.binary) ? 'Binary' : 'Text' },
      ],
    }),

  mirth_audit_accessed_phi_message: audit(
    'Record that a PHI message was viewed',
    'who viewed which message'
  ),
  mirth_audit_queried_phi_messages: audit(
    'Record that PHI messages were queried',
    'what was searched for'
  ),
  mirth_audit_export_messages: audit('Record that messages were exported', 'an export was started'),
  mirth_audit_export_messages_success: audit(
    'Record that an export succeeded',
    'an export finished'
  ),

  mirth_update_server_settings: (args, names) =>
    change(args, names, {
      verb: 'Replace',
      tone: 'danger',
      icon: 'gear',
      title: 'Replace the server settings',
      subject: 'Server settings',
      rows: [block('New settings', args.settings)],
      notes: ['These replace the current settings in full.'],
    }),

  mirth_send_test_email: (args, names) =>
    change(args, names, {
      verb: 'Send',
      icon: 'mail',
      title: 'Send a test email from the server',
      subject: 'SMTP settings',
      rows: [block('Properties', args.properties)],
      notes: ['An email is sent using these settings.'],
    }),

  mirth_update_update_settings: (args, names) =>
    change(args, names, {
      verb: 'Change',
      tone: 'caution',
      icon: 'gear',
      title: 'Change the update settings',
      subject: 'Update settings',
      rows: [block('New settings', args.settings)],
    }),

  mirth_update_database_drivers: (args, names) =>
    change(args, names, {
      verb: 'Replace',
      tone: 'danger',
      icon: 'gear',
      title: 'Replace the database driver list',
      subject: 'Database drivers',
      rows: [block('New list', args.drivers)],
      notes: ['The whole list is replaced; a driver left out stops being available.'],
    }),

  mirth_update_resources: (args, names) =>
    change(args, names, {
      verb: 'Replace',
      tone: 'danger',
      icon: 'gear',
      title: 'Replace the resources',
      subject: 'Resources',
      rows: [block('New list', args.resources)],
      notes: ['The whole list is replaced.'],
    }),

  mirth_reload_resource: (args, names) =>
    change(args, names, {
      verb: 'Reload',
      icon: 'play',
      title: 'Reload a resource',
      subject: labelOr(names, 'resource', args.resourceId, 'The resource'),
      kind: 'Resource',
      rows: [],
      notes: ['Channels using it pick up changes to its files.'],
    }),

  mirth_update_channel_dependencies: (args, names) =>
    change(args, names, {
      verb: 'Replace',
      tone: 'caution',
      icon: 'link',
      title: 'Replace channel dependencies',
      subject: 'Channel dependencies',
      rows: [block('New dependencies', args.dependencies)],
      notes: ['Controls the order channels deploy in.'],
    }),

  mirth_update_channel_metadata: (args, names) =>
    change(args, names, {
      verb: 'Replace',
      icon: 'tag',
      title: 'Replace channel metadata',
      subject: 'Channel metadata',
      rows: [block('New metadata', args.metadata)],
    }),

  mirth_update_channel_tags: (args, names) =>
    change(args, names, {
      verb: 'Replace',
      icon: 'tag',
      title: 'Replace channel tags',
      subject: 'Channel tags',
      rows: [block('New tags', args.channelTags)],
    }),

  mirth_create_user: (args, names) =>
    change(args, names, {
      verb: 'Create',
      tone: 'caution',
      icon: 'user',
      title: 'Create a Mirth user',
      subject: 'New user',
      kind: 'User',
      rows: [block('User', args.user)],
      notes: ['The new user can sign in to Mirth with the role the definition gives them.'],
    }),

  mirth_update_user: (args, names) =>
    change(args, names, {
      verb: 'Update',
      tone: 'caution',
      icon: 'user',
      title: `Update ${titled(names, 'user', 'Mirth user', args.userId)}`,
      subject: userOf(args, names),
      kind: 'User',
      rows: [block('New definition', args.user)],
    }),

  mirth_update_user_preferences: (args, names) =>
    change(args, names, {
      verb: 'Set',
      icon: 'user',
      title: `Set preferences for ${titled(names, 'user', 'Mirth user', args.userId)}`,
      subject: userOf(args, names),
      kind: 'User',
      rows: [block('Preferences', args.properties)],
    }),

  mirth_set_user_preference: (args, names) =>
    change(args, names, {
      verb: 'Set',
      icon: 'user',
      title: `Set the preference ${text(args.name)}`,
      subject: userOf(args, names),
      kind: 'User',
      rows: [{ label: text(args.name), value: text(args.value) }],
    }),

  mirth_acknowledge_user_notification: (args, names) =>
    change(args, names, {
      verb: 'Acknowledge',
      icon: 'bell',
      title: 'Mark a user’s notifications as read',
      subject: userOf(args, names),
      kind: 'User',
      rows: [],
    }),

  mirth_export_events: (args, names) =>
    change(args, names, {
      verb: 'Export',
      icon: 'upload',
      title: 'Export every event',
      subject: 'Event log',
      rows: [],
      notes: ['Writes the whole event log out; it may be large.'],
    }),

  mirth_create_alert: (args, names) =>
    change(args, names, {
      verb: 'Create',
      icon: 'bell',
      title: 'Create an alert',
      subject: 'New alert',
      kind: 'Alert',
      rows: [block('Alert', args.alertModel)],
    }),

  mirth_update_alert: (args, names) =>
    change(args, names, {
      verb: 'Update',
      tone: 'caution',
      icon: 'bell',
      title: `Update ${titled(names, 'alert', 'alert', args.alertId)}`,
      subject: alertOf(args, names),
      kind: 'Alert',
      rows: [block('New definition', args.alertModel)],
    }),

  mirth_update_code_template_libraries: (args, names) =>
    change(args, names, {
      verb: 'Replace',
      tone: 'danger',
      icon: 'doc',
      title: 'Replace all code template libraries',
      subject: 'Code template libraries',
      rows: [
        block('New libraries', args.libraries),
        { label: 'Overwrite newer changes', value: yes(args.override) ? 'Yes' : 'No' },
      ],
      notes: [
        'Every library is replaced by the ones shown; channels using their code are affected.',
      ],
    }),

  mirth_update_code_template: (args, names) =>
    change(args, names, {
      verb: 'Save',
      tone: 'caution',
      icon: 'doc',
      title: `Save ${titled(names, 'code_template', 'code template', args.codeTemplateId)}`,
      subject: templateOf(args, names),
      kind: 'Code template',
      rows: [
        block('Template', args.codeTemplate),
        { label: 'Overwrite newer changes', value: yes(args.override) ? 'Yes' : 'No' },
      ],
    }),

  mirth_set_extension_enabled: (args, names) => ({
    verb: yes(args.enabled) ? 'Enable' : 'Disable',
    tone: yes(args.enabled) ? 'positive' : 'caution',
    icon: yes(args.enabled) ? 'check' : 'stop',
    title: `${yes(args.enabled) ? 'Enable' : 'Disable'} the extension ${text(args.extensionName)}`,
    subtitle: instance(args, names),
    confirmLabel: yes(args.enabled) ? 'Enable extension' : 'Disable extension',
    body: {
      kind: 'transition',
      subject: ref(text(args.extensionName), 'Extension'),
      field: 'Extension',
      to: yes(args.enabled) ? 'Enabled' : 'Disabled',
    },
  }),

  mirth_update_extension_properties: (args, names) =>
    change(args, names, {
      verb: 'Set',
      tone: 'caution',
      icon: 'gear',
      title: `Set properties of ${text(args.extensionName)}`,
      subject: text(args.extensionName),
      kind: 'Extension',
      rows: [
        block('Properties', args.properties),
        {
          label: 'Existing properties',
          value: yes(args.mergeProperties) ? 'Kept; these are merged in' : 'Replaced by these',
        },
      ],
    }),

  mirth_cancel_database_task: (args, names) =>
    change(args, names, {
      verb: 'Cancel',
      tone: 'caution',
      icon: 'stop',
      title: `Cancel ${titled(names, 'database_task', 'database task', args.databaseTaskId)}`,
      subject: labelOr(names, 'database_task', args.databaseTaskId, 'The task'),
      kind: 'Database task',
      rows: [],
      notes: ['A task cancelled part-way may leave its work half done.'],
    }),

  mirth_generate_usage_data: (args, names) =>
    change(args, names, {
      verb: 'Generate',
      icon: 'doc',
      title: 'Generate the usage document',
      subject: 'Usage data',
      rows: text(args.clientStats) ? [block('Client statistics', args.clientStats)] : [],
    }),
};
