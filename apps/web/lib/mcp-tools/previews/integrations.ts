/**
 * Preview cards for the integration engines and document systems:
 * Mirth Connect (channels, messages, configuration) and OnBase (documents
 * and their administration). Mirth's deletes, and removing messages, have
 * hand-written cards next to their tools.
 */

import type { Row } from '@/lib/mcp-widgets/src/act-card';
import type { Names, PreviewBuilder, PreviewSpec } from './card';
import { clip, count, record, records, ref, show, strings, text, yes } from './card';
import { labelOr, labelsOr } from './readable';

type Args = Record<string, unknown>;

const MIRTH = 'Mirth Connect';
const ONBASE = 'OnBase';

const instance = (args: Args, names: Names) => {
  const name = labelOr(names, 'instance', args.instanceId, '');
  return name ? `${MIRTH} · ${name}` : MIRTH;
};

function channels(args: Args): string[] {
  return strings(args.channelIds);
}

/** The channels' names, one each; a channel that could not be named is "A channel". */
const channelNames = (args: Args, names: Names) =>
  labelsOr(names, 'channel', args.channelIds, 'A channel');

const channelSet = (args: Args, names: Names) => {
  const list = channelNames(args, names);
  if (list.length === 1) return list[0] === 'A channel' ? 'a channel' : `the channel ${list[0]}`;
  return list.length > 0 ? count(list.length, 'channel') : 'the channels you named';
};

/** A single channel's name for a title, or "a channel". */
const channelTitle = (args: Args, names: Names) => {
  const name = labelOr(names, 'channel', args.channelId, '');
  return name ? `the channel ${name}` : 'a channel';
};
const channelName = (args: Args, names: Names) =>
  labelOr(names, 'channel', args.channelId, 'The channel');

function channelState(
  args: Args,
  names: Names,
  action: string,
  to: string,
  verb: string,
  tone: PreviewSpec['tone'] = 'neutral'
): PreviewSpec {
  const ids = channels(args);
  const list = channelNames(args, names);
  return {
    verb,
    tone,
    icon: action === 'start' || action === 'resume' ? 'play' : 'stop',
    title: `${verb} ${channelSet(args, names)}`,
    subtitle: instance(args, names),
    confirmLabel: `${verb} ${ids.length === 1 ? 'channel' : 'channels'}`,
    body: {
      kind: 'transition',
      ...(ids.length === 1
        ? { subject: ref(list[0] ?? 'A channel', 'Channel') }
        : { query: list.join('\n') || 'The channels you named' }),
      field: 'Channel state',
      to,
    },
  };
}

const CONTROL: Record<string, [string, string, PreviewSpec['tone']]> = {
  start: ['Start', 'Started', 'positive'],
  stop: ['Stop', 'Stopped', 'caution'],
  pause: ['Pause', 'Paused', 'caution'],
  resume: ['Resume', 'Started', 'positive'],
  halt: ['Halt', 'Halted — in-flight messages are dropped', 'danger'],
};

function xmlName(xml: string): string {
  return /<name>([^<]*)<\/name>/.exec(xml)?.[1]?.trim() ?? '';
}

function keywordRows(value: unknown, names: Names): Row[] {
  return records(value).map((entry) => ({
    label: labelOr(names, 'keyword type', entry.type, 'A keyword'),
    value: strings(entry.values).length > 0 ? strings(entry.values).join(', ') : '(blank)',
  }));
}

/** Filter arguments that are connector handles: shown by the connector's name. */
const CONNECTOR_FILTERS = ['includedMetaDataId', 'excludedMetaDataId'];

/** OnBase administration arguments that take a name or an id, and what each one names. */
const ADMIN_REFS: Record<string, [kind: string, generic: string]> = {
  documentTypeGroup: ['document type group', 'A document type group'],
  keywordTypeGroup: ['keyword type group', 'A keyword type group'],
  defaultFileFormat: ['file type', 'A file type'],
  defaultDiskGroup: ['disk group', 'A disk group'],
  userGroups: ['user group', 'A user group'],
};

function nameRows(args: Args, skip: string[], names: Names = {}): Row[] {
  return Object.entries(args)
    .filter(
      ([key, value]) => !skip.includes(key) && value !== undefined && value !== null && value !== ''
    )
    .map(([label, value]) => {
      const admin = ADMIN_REFS[label];
      const shown = CONNECTOR_FILTERS.includes(label)
        ? labelsOr(names, 'connector', value, 'A connector').join(', ')
        : admin && (typeof value === 'string' || Array.isArray(value))
          ? labelsOr(names, admin[0], value, admin[1]).join(', ')
          : show(value);
      return { label, value: shown, block: shown.length > 80 };
    });
}

/** "the document type Invoices", or "a document type" when it has no name to show. */
function adminTitle(names: Names, kind: string, value: unknown): string {
  const name = labelOr(names, kind, value, '');
  return name ? `the ${kind} ${name}` : `a ${kind}`;
}

function groups(value: unknown, names: Names): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const entry of records(value)) {
    const name = labelOr(names, 'user group', entry.userGroup, 'A user group');
    if (name) (yes(entry.remove) ? remove : add).push(name);
  }
  return { add, remove };
}

/** A document, by name — "the document" when none is known. */
const documentName = (names: Names, id: unknown) => labelOr(names, 'document', id, '');
const typeName = (names: Names, value: unknown) =>
  labelOr(names, 'document type', value, 'a document type');

function adminCreate(noun: string, nameKey: string, skip: string[]) {
  return (args: Args, names: Names): PreviewSpec => ({
    verb: 'Create',
    icon: 'gear',
    title: `Create the ${noun} ${text(args[nameKey])}`,
    subtitle: `${ONBASE} · Administration`,
    confirmLabel: `Create ${noun}`,
    body: {
      kind: 'change',
      subject: ref(text(args[nameKey]), noun),
      rows: nameRows(args, [nameKey, ...skip], names),
      notes: ['Created in OnBase now; changing it afterwards is a separate edit.'],
    },
  });
}

export const INTEGRATION_PREVIEWS: Record<string, PreviewBuilder> = {
  mirth_deploy_channels: (args, names) => ({
    verb: 'Deploy',
    tone: yes(args.all) ? 'danger' : 'caution',
    icon: 'upload',
    title: yes(args.all) ? 'Redeploy every channel' : `Deploy ${channelSet(args, names)}`,
    subtitle: instance(args, names),
    confirmLabel: yes(args.all) ? 'Redeploy everything' : 'Deploy',
    body: {
      kind: 'change',
      subject: ref(yes(args.all) ? 'Every channel' : channelSet(args, names), 'Mirth channels'),
      rows:
        channels(args).length > 0 ? [{ label: 'Channels', add: channelNames(args, names) }] : [],
      notes: [
        'Deploying restarts a channel; messages in flight are finished first.',
        ...(yes(args.all)
          ? ['Every channel on the server is redeployed, including ones you have not looked at.']
          : []),
      ],
    },
  }),

  mirth_undeploy_channels: (args, names) => ({
    verb: 'Undeploy',
    tone: 'danger',
    icon: 'stop',
    title: `Undeploy ${channelSet(args, names)}`,
    subtitle: instance(args, names),
    confirmLabel: 'Undeploy',
    body: {
      kind: 'change',
      subject: ref(channelSet(args, names), 'Mirth channels'),
      rows: [{ label: 'Channels', remove: channelNames(args, names) }],
      notes: ['Nothing is received or sent on an undeployed channel.'],
    },
  }),

  mirth_control_channels: (args, names) => {
    const [verb, to, tone] = CONTROL[text(args.action)] ?? [
      'Change',
      text(args.action),
      'neutral' as const,
    ];
    return channelState(args, names, text(args.action), to, verb, tone);
  },

  mirth_control_connector: (args, names) => {
    const connector = labelOr(names, 'connector', args.metaDataId, '');
    const start = text(args.action) === 'start';
    return {
      verb: start ? 'Start' : 'Stop',
      tone: start ? 'positive' : 'caution',
      icon: start ? 'play' : 'stop',
      title: `${start ? 'Start' : 'Stop'} ${connector ? `the connector ${connector}` : 'a connector'}`,
      subtitle: instance(args, names),
      confirmLabel: start ? 'Start connector' : 'Stop connector',
      body: {
        kind: 'transition',
        subject: ref(
          channelName(args, names),
          'Channel',
          connector ? `Connector ${connector}` : 'A connector'
        ),
        field: 'Connector state',
        to: start ? 'Started' : 'Stopped',
      },
    };
  },

  mirth_set_channel_enabled: (args, names) => ({
    verb: yes(args.enabled) ? 'Enable' : 'Disable',
    tone: yes(args.enabled) ? 'positive' : 'caution',
    icon: yes(args.enabled) ? 'check' : 'stop',
    title: `${yes(args.enabled) ? 'Enable' : 'Disable'} ${channelTitle(args, names)}`,
    subtitle: instance(args, names),
    confirmLabel: yes(args.enabled) ? 'Enable channel' : 'Disable channel',
    body: {
      kind: 'transition',
      subject: ref(channelName(args, names), 'Channel'),
      field: 'Channel',
      to: yes(args.enabled) ? 'Enabled' : 'Disabled',
    },
  }),

  mirth_set_channel_initial_state: (args, names) => ({
    verb: 'Set state',
    icon: 'gear',
    title: `Deploy ${channelTitle(args, names)} ${text(args.initialState).toLowerCase()}`,
    subtitle: instance(args, names),
    confirmLabel: 'Set initial state',
    body: {
      kind: 'transition',
      subject: ref(channelName(args, names), 'Channel'),
      field: 'State after each deploy',
      to: text(args.initialState),
    },
  }),

  mirth_import_channel: (args, names) => {
    const xml = text(args.channelXml);
    return {
      verb: 'Import',
      tone: 'caution',
      icon: 'upload',
      title: `Import the channel ${xmlName(xml) || 'from XML'}`,
      subtitle: instance(args, names),
      confirmLabel: 'Import channel',
      body: {
        kind: 'document',
        mode: 'create',
        type: 'Channel',
        title: xmlName(xml) || 'Unnamed channel',
        body: clip(xml, 1500),
        bodyLabel: `Channel definition (${xml.length.toLocaleString('en')} characters)`,
        versionNote:
          'A channel that already exists on the server is overwritten; a new one is created undeployed.',
      },
    };
  },

  mirth_send_message: (args, names) => {
    const destinations = labelsOr(names, 'connector', args.destinationMetaDataIds, 'A destination');
    const sourceMap = record(args.sourceMap);
    return {
      verb: 'Send',
      tone: 'caution',
      icon: 'mail',
      title: `Send a message through ${channelTitle(args, names)}`,
      subtitle: instance(args, names),
      confirmLabel: 'Send message',
      body: {
        kind: 'change',
        subject: ref(channelName(args, names), 'Channel'),
        rows: [
          { label: 'Message', value: clip(text(args.content), 1500), block: true },
          {
            label: 'To',
            value:
              destinations.length > 0
                ? `Destinations ${destinations.join(', ')}`
                : 'Every destination',
          },
          ...Object.entries(sourceMap).map(([label, value]) => ({
            label: `sourceMap.${label}`,
            value: show(value),
          })),
        ],
        notes: ['The message is processed as if it had arrived: destinations act on it for real.'],
      },
    };
  },

  mirth_reprocess_messages: (args, names) => {
    const filters = nameRows(
      args,
      ['instanceId', 'channelId', 'messageId', 'replace', 'destinationMetaDataIds'],
      names
    );
    const through = labelsOr(names, 'connector', args.destinationMetaDataIds, 'A destination');
    return {
      verb: 'Reprocess',
      tone: yes(args.replace) ? 'danger' : 'caution',
      icon: 'play',
      title:
        args.messageId === undefined
          ? 'Reprocess the messages matching a filter'
          : `Reprocess a message of ${channelTitle(args, names)}`,
      subtitle: instance(args, names),
      confirmLabel: 'Reprocess',
      body: {
        kind: 'change',
        subject: ref(channelName(args, names), 'Channel'),
        rows: [
          ...(args.messageId === undefined
            ? filters
            : [{ label: 'Message', value: 'The one message you named' }]),
          ...(through.length > 0 ? [{ label: 'Only through', value: through.join(', ') }] : []),
        ],
        notes: [
          yes(args.replace)
            ? 'The original messages are overwritten with the reprocessed ones.'
            : 'The originals are kept; reprocessing makes new messages.',
          'Destinations act on them again for real.',
        ],
      },
    };
  },

  mirth_set_configuration_map: (args, names) => {
    const entries = record(args.entries);
    const removed: string[] = [];
    const rows: Row[] = [];
    for (const [key, raw] of Object.entries(entries)) {
      if (raw === null) removed.push(key);
      else
        rows.push({ label: key, value: typeof raw === 'string' ? raw : text(record(raw).value) });
    }
    return {
      verb: 'Change',
      tone: 'caution',
      icon: 'gear',
      title: 'Change the configuration map',
      subtitle: instance(args, names),
      confirmLabel: 'Save configuration map',
      body: {
        kind: 'change',
        subject: ref('Configuration map', 'Server'),
        rows: [...rows, ...(removed.length > 0 ? [{ label: 'Removed', remove: removed }] : [])],
        notes: ['Channels read these values when they are next deployed.'],
      },
    };
  },

  mirth_set_global_scripts: (args, names) => {
    const scripts = record(args.scripts);
    return {
      verb: 'Replace',
      tone: 'danger',
      icon: 'gear',
      title: 'Replace global scripts',
      subtitle: instance(args, names),
      confirmLabel: 'Replace scripts',
      body: {
        kind: 'change',
        subject: ref('Global scripts', 'Server'),
        rows: Object.entries(scripts).map(([label, value]) => ({
          label,
          value: clip(text(value) || '(emptied)', 1200),
          block: true,
        })),
        notes: [
          'Each script shown replaces the current one in full. Ones not shown are untouched.',
        ],
      },
    };
  },

  mirth_set_alert_enabled: (args, names) => {
    const alert = labelOr(names, 'alert', args.alertId, '');
    return {
      verb: yes(args.enabled) ? 'Enable' : 'Disable',
      tone: yes(args.enabled) ? 'positive' : 'caution',
      icon: 'bell',
      title: `${yes(args.enabled) ? 'Enable' : 'Disable'} ${alert ? `the alert ${alert}` : 'an alert'}`,
      subtitle: instance(args, names),
      confirmLabel: yes(args.enabled) ? 'Enable alert' : 'Disable alert',
      body: {
        kind: 'transition',
        subject: ref(alert || 'The alert', 'Alert'),
        field: 'Alert',
        to: yes(args.enabled) ? 'Enabled' : 'Disabled',
      },
    };
  },

  onbase_add_note: (args, names) => ({
    verb: 'Add note',
    icon: 'comment',
    title: documentName(names, args.documentId)
      ? `Add a note to ${documentName(names, args.documentId)}`
      : 'Add a note to a document',
    subtitle: ONBASE,
    confirmLabel: 'Add note',
    editable: [{ key: 'text', label: 'Note', multiline: true }],
    body: {
      kind: 'comment',
      mode: 'note',
      on: ref(
        documentName(names, args.documentId) || 'The document',
        'Document',
        text(args.noteType)
      ),
      bodyKey: 'text',
      body: text(args.text) || '(the note type’s default text)',
      badges: [`Page ${text(args.page) || '1'}`, text(args.noteType)].filter(Boolean),
    },
  }),

  onbase_archive_document: (args, names) => ({
    verb: 'Archive',
    icon: 'upload',
    title: `Archive a document as ${typeName(names, args.documentType)}`,
    subtitle: ONBASE,
    confirmLabel: 'Archive document',
    body: {
      kind: 'change',
      subject: ref('Uploaded file', undefined, typeName(names, args.documentType)),
      rows: [
        { label: 'Document type', value: typeName(names, args.documentType) },
        ...keywordRows(args.keywords, names),
        ...(text(args.documentDate)
          ? [{ label: 'Document date', value: text(args.documentDate) }]
          : []),
        ...(text(args.comment) ? [{ label: 'Revision comment', value: text(args.comment) }] : []),
      ],
      notes: [
        yes(args.storeAsNew)
          ? 'Stored as a new document even if OnBase finds a match.'
          : 'If OnBase finds a matching document, this becomes a revision of it.',
      ],
    },
  }),

  onbase_reindex_document: (args, names) => ({
    verb: 'Reindex',
    tone: 'caution',
    icon: 'tag',
    title: `Reindex ${documentName(names, args.documentId) || 'a document'} as ${typeName(names, args.targetDocumentType)}`,
    subtitle: ONBASE,
    confirmLabel: 'Reindex',
    body: {
      kind: 'change',
      subject: ref(documentName(names, args.documentId) || 'The document', 'Document'),
      rows: [
        { label: 'Document type', value: typeName(names, args.targetDocumentType) },
        ...(text(args.documentDate)
          ? [{ label: 'Document date', value: text(args.documentDate) }]
          : []),
        ...(text(args.comment) ? [{ label: 'Revision comment', value: text(args.comment) }] : []),
      ],
      notes: ['The document is filed under a different type, with that type’s permissions.'],
    },
  }),

  onbase_update_keywords: (args, names) => ({
    verb: 'Update',
    icon: 'tag',
    title: documentName(names, args.documentId)
      ? `Update the keywords on ${documentName(names, args.documentId)}`
      : 'Update the keywords on a document',
    subtitle: ONBASE,
    confirmLabel: 'Update keywords',
    body: {
      kind: 'change',
      subject: ref(documentName(names, args.documentId) || 'The document', 'Document'),
      rows: keywordRows(args.keywords, names),
      notes: ['Each keyword shown is replaced by exactly the values listed.'],
    },
  }),

  onbase_admin_create_document_type: adminCreate('document type', 'name', []),
  onbase_admin_create_keyword_type: adminCreate('keyword type', 'name', []),
  onbase_admin_create_document_type_group: adminCreate('document type group', 'name', []),
  onbase_admin_create_keyword_type_group: (args, names) => ({
    verb: 'Create',
    icon: 'gear',
    title: `Create the keyword type group ${text(args.name)}`,
    subtitle: `${ONBASE} · Administration`,
    confirmLabel: 'Create group',
    body: {
      kind: 'change',
      subject: ref(text(args.name), 'Keyword type group'),
      rows: [
        {
          label: 'Keyword types',
          add: records(args.keywordTypes).map((entry) =>
            labelOr(
              names,
              'keyword type',
              text(entry.keywordType) || text(entry.name),
              'A keyword type'
            )
          ),
        },
        ...nameRows(args, ['name', 'keywordTypes'], names),
      ],
    },
  }),
  onbase_admin_create_file_type: adminCreate('file type', 'name', []),

  onbase_admin_update_document_type: (args, names) => ({
    verb: 'Update',
    tone: 'caution',
    icon: 'gear',
    title: `Update ${adminTitle(names, 'document type', args.documentType)}`,
    subtitle: `${ONBASE} · Administration`,
    confirmLabel: 'Update document type',
    body: {
      kind: 'change',
      subject: ref(typeName(names, args.documentType), 'Document type'),
      rows: Object.entries(record(args.fields)).map(([label, value]) => ({
        label,
        value: show(value),
      })),
      notes: ['Only the settings shown change.'],
    },
  }),

  onbase_admin_update_keyword_type: (args, names) => ({
    verb: 'Update',
    tone: 'caution',
    icon: 'gear',
    title: `Update ${adminTitle(names, 'keyword type', args.keywordType)}`,
    subtitle: `${ONBASE} · Administration`,
    confirmLabel: 'Update keyword type',
    body: {
      kind: 'change',
      subject: ref(
        labelOr(names, 'keyword type', args.keywordType, 'A keyword type'),
        'Keyword type'
      ),
      rows: Object.entries(record(args.fields)).map(([label, value]) => ({
        label,
        value: show(value),
      })),
      notes: ['Only the settings shown change.'],
    },
  }),

  onbase_admin_assign_keyword_types: (args, names) => ({
    verb: 'Assign',
    tone: 'caution',
    icon: 'tag',
    title: `Change the keywords on ${adminTitle(names, 'document type', args.documentType)}`,
    subtitle: `${ONBASE} · Administration`,
    confirmLabel: 'Save assignments',
    body: {
      kind: 'change',
      subject: ref(typeName(names, args.documentType), 'Document type'),
      rows: [
        {
          label: 'Keyword types',
          add: records(args.assignments)
            .filter((entry) => !yes(entry.remove))
            .map((entry) => labelOr(names, 'keyword type', entry.keywordType, 'A keyword type')),
          remove: records(args.assignments)
            .filter((entry) => yes(entry.remove))
            .map((entry) => labelOr(names, 'keyword type', entry.keywordType, 'A keyword type')),
        },
      ],
    },
  }),

  onbase_admin_assign_document_type_user_groups: (args, names) => {
    const { add, remove } = groups(args.userGroups, names);
    return {
      verb: 'Change access',
      tone: 'caution',
      icon: 'users',
      title: `Change who can use ${adminTitle(names, 'document type', args.documentType)}`,
      subtitle: `${ONBASE} · Administration`,
      confirmLabel: 'Save access',
      body: {
        kind: 'change',
        subject: ref(typeName(names, args.documentType), 'Document type'),
        rows: [{ label: 'User groups', add, remove }],
      },
    };
  },

  onbase_admin_assign_document_type_group_user_groups: (args, names) => {
    const { add, remove } = groups(args.userGroups, names);
    return {
      verb: 'Change access',
      tone: 'caution',
      icon: 'users',
      title: `Change who can use ${adminTitle(names, 'document type group', args.documentTypeGroup)}`,
      subtitle: `${ONBASE} · Administration`,
      confirmLabel: 'Save access',
      body: {
        kind: 'change',
        subject: ref(
          labelOr(names, 'document type group', args.documentTypeGroup, 'A document type group'),
          'Document type group'
        ),
        rows: [{ label: 'User groups', add, remove }],
      },
    };
  },
};
