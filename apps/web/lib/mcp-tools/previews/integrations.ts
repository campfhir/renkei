/**
 * Preview cards for the integration engines and document systems:
 * Mirth Connect (channels, messages, configuration) and OnBase (documents
 * and their administration). Mirth's deletes, and removing messages, have
 * hand-written cards next to their tools.
 */

import type { Row } from '@/lib/mcp-widgets/src/act-card';
import type { PreviewBuilder, PreviewSpec } from './card';
import { clip, count, record, records, ref, show, strings, text, yes } from './card';

type Args = Record<string, unknown>;

const MIRTH = 'Mirth Connect';
const ONBASE = 'OnBase';

const instance = (args: Args) => `${MIRTH} · ${text(args.instanceId) || 'instance'}`;

function channels(args: Args): string[] {
  return strings(args.channelIds);
}

const channelSet = (args: Args) =>
  channels(args).length > 0 ? count(channels(args).length, 'channel') : 'the channels you named';

function channelState(
  args: Args,
  action: string,
  to: string,
  verb: string,
  tone: PreviewSpec['tone'] = 'neutral'
): PreviewSpec {
  const ids = channels(args);
  return {
    verb,
    tone,
    icon: action === 'start' || action === 'resume' ? 'play' : 'stop',
    title: `${verb} ${channelSet(args)}`,
    subtitle: instance(args),
    confirmLabel: `${verb} ${ids.length === 1 ? 'channel' : 'channels'}`,
    body: {
      kind: 'transition',
      ...(ids.length === 1
        ? { subject: ref(ids[0] ?? '', 'Channel') }
        : { query: ids.join('\n') || 'The channels you named' }),
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

function keywordRows(value: unknown): Row[] {
  return records(value).map((entry) => ({
    label: text(entry.type),
    value: strings(entry.values).length > 0 ? strings(entry.values).join(', ') : '(blank)',
  }));
}

function nameRows(args: Args, skip: string[]): Row[] {
  return Object.entries(args)
    .filter(
      ([key, value]) => !skip.includes(key) && value !== undefined && value !== null && value !== ''
    )
    .map(([label, value]) => ({ label, value: show(value), block: show(value).length > 80 }));
}

function groups(value: unknown): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const entry of records(value)) {
    const name = text(entry.userGroup);
    if (name) (yes(entry.remove) ? remove : add).push(name);
  }
  return { add, remove };
}

function adminCreate(noun: string, nameKey: string, skip: string[]) {
  return (args: Args): PreviewSpec => ({
    verb: 'Create',
    icon: 'gear',
    title: `Create the ${noun} ${text(args[nameKey])}`,
    subtitle: `${ONBASE} · Administration`,
    confirmLabel: `Create ${noun}`,
    body: {
      kind: 'change',
      subject: ref(text(args[nameKey]), noun),
      rows: nameRows(args, [nameKey, ...skip]),
      notes: ['Created in OnBase now; changing it afterwards is a separate edit.'],
    },
  });
}

export const INTEGRATION_PREVIEWS: Record<string, PreviewBuilder> = {
  mirth_deploy_channels: (args) => ({
    verb: 'Deploy',
    tone: yes(args.all) ? 'danger' : 'caution',
    icon: 'upload',
    title: yes(args.all) ? 'Redeploy every channel' : `Deploy ${channelSet(args)}`,
    subtitle: instance(args),
    confirmLabel: yes(args.all) ? 'Redeploy everything' : 'Deploy',
    body: {
      kind: 'change',
      subject: ref(yes(args.all) ? 'Every channel' : channelSet(args), 'Mirth channels'),
      rows: channels(args).length > 0 ? [{ label: 'Channels', add: channels(args) }] : [],
      notes: [
        'Deploying restarts a channel; messages in flight are finished first.',
        ...(yes(args.all)
          ? ['Every channel on the server is redeployed, including ones you have not looked at.']
          : []),
      ],
    },
  }),

  mirth_undeploy_channels: (args) => ({
    verb: 'Undeploy',
    tone: 'danger',
    icon: 'stop',
    title: `Undeploy ${channelSet(args)}`,
    subtitle: instance(args),
    confirmLabel: 'Undeploy',
    body: {
      kind: 'change',
      subject: ref(channelSet(args), 'Mirth channels'),
      rows: [{ label: 'Channels', remove: channels(args) }],
      notes: ['Nothing is received or sent on an undeployed channel.'],
    },
  }),

  mirth_control_channels: (args) => {
    const [verb, to, tone] = CONTROL[text(args.action)] ?? [
      'Change',
      text(args.action),
      'neutral' as const,
    ];
    return channelState(args, text(args.action), to, verb, tone);
  },

  mirth_control_connector: (args) => ({
    verb: text(args.action) === 'start' ? 'Start' : 'Stop',
    tone: text(args.action) === 'start' ? 'positive' : 'caution',
    icon: text(args.action) === 'start' ? 'play' : 'stop',
    title: `${text(args.action) === 'start' ? 'Start' : 'Stop'} a connector`,
    subtitle: instance(args),
    confirmLabel: text(args.action) === 'start' ? 'Start connector' : 'Stop connector',
    body: {
      kind: 'transition',
      subject: ref(text(args.channelId), 'Channel', `Connector ${text(args.metaDataId)}`),
      field: 'Connector state',
      to: text(args.action) === 'start' ? 'Started' : 'Stopped',
    },
  }),

  mirth_set_channel_enabled: (args) => ({
    verb: yes(args.enabled) ? 'Enable' : 'Disable',
    tone: yes(args.enabled) ? 'positive' : 'caution',
    icon: yes(args.enabled) ? 'check' : 'stop',
    title: `${yes(args.enabled) ? 'Enable' : 'Disable'} a channel`,
    subtitle: instance(args),
    confirmLabel: yes(args.enabled) ? 'Enable channel' : 'Disable channel',
    body: {
      kind: 'transition',
      subject: ref(text(args.channelId), 'Channel'),
      field: 'Channel',
      to: yes(args.enabled) ? 'Enabled' : 'Disabled',
    },
  }),

  mirth_set_channel_initial_state: (args) => ({
    verb: 'Set state',
    icon: 'gear',
    title: `Deploy a channel ${text(args.initialState).toLowerCase()}`,
    subtitle: instance(args),
    confirmLabel: 'Set initial state',
    body: {
      kind: 'transition',
      subject: ref(text(args.channelId), 'Channel'),
      field: 'State after each deploy',
      to: text(args.initialState),
    },
  }),

  mirth_import_channel: (args) => {
    const xml = text(args.channelXml);
    return {
      verb: 'Import',
      tone: 'caution',
      icon: 'upload',
      title: `Import the channel ${xmlName(xml) || 'from XML'}`,
      subtitle: instance(args),
      confirmLabel: 'Import channel',
      body: {
        kind: 'document',
        mode: 'create',
        type: 'Channel',
        title: xmlName(xml) || 'Unnamed channel',
        body: clip(xml, 1500),
        bodyLabel: `Channel definition (${xml.length.toLocaleString('en')} characters)`,
        versionNote: 'A channel with the same id is overwritten; a new one is created undeployed.',
      },
    };
  },

  mirth_send_message: (args) => {
    const destinations = strings(args.destinationMetaDataIds);
    const sourceMap = record(args.sourceMap);
    return {
      verb: 'Send',
      tone: 'caution',
      icon: 'mail',
      title: 'Send a message through a channel',
      subtitle: instance(args),
      confirmLabel: 'Send message',
      body: {
        kind: 'change',
        subject: ref(text(args.channelId), 'Channel'),
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

  mirth_reprocess_messages: (args) => {
    const filters = nameRows(args, [
      'instanceId',
      'channelId',
      'messageId',
      'replace',
      'destinationMetaDataIds',
    ]);
    return {
      verb: 'Reprocess',
      tone: yes(args.replace) ? 'danger' : 'caution',
      icon: 'play',
      title:
        args.messageId === undefined
          ? 'Reprocess the messages matching a filter'
          : `Reprocess message ${text(args.messageId)}`,
      subtitle: instance(args),
      confirmLabel: 'Reprocess',
      body: {
        kind: 'change',
        subject: ref(text(args.channelId), 'Channel'),
        rows: [
          ...(args.messageId === undefined
            ? filters
            : [{ label: 'Message', value: text(args.messageId) }]),
          ...(strings(args.destinationMetaDataIds).length > 0
            ? [{ label: 'Only through', value: strings(args.destinationMetaDataIds).join(', ') }]
            : []),
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

  mirth_set_configuration_map: (args) => {
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
      subtitle: instance(args),
      confirmLabel: 'Save configuration map',
      body: {
        kind: 'change',
        subject: ref('Configuration map', 'Server'),
        rows: [...rows, ...(removed.length > 0 ? [{ label: 'Removed', remove: removed }] : [])],
        notes: ['Channels read these values when they are next deployed.'],
      },
    };
  },

  mirth_set_global_scripts: (args) => {
    const scripts = record(args.scripts);
    return {
      verb: 'Replace',
      tone: 'danger',
      icon: 'gear',
      title: 'Replace global scripts',
      subtitle: instance(args),
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

  mirth_set_alert_enabled: (args) => ({
    verb: yes(args.enabled) ? 'Enable' : 'Disable',
    tone: yes(args.enabled) ? 'positive' : 'caution',
    icon: 'bell',
    title: `${yes(args.enabled) ? 'Enable' : 'Disable'} an alert`,
    subtitle: instance(args),
    confirmLabel: yes(args.enabled) ? 'Enable alert' : 'Disable alert',
    body: {
      kind: 'transition',
      subject: ref(text(args.alertId), 'Alert'),
      field: 'Alert',
      to: yes(args.enabled) ? 'Enabled' : 'Disabled',
    },
  }),

  onbase_add_note: (args) => ({
    verb: 'Add note',
    icon: 'comment',
    title: `Add a note to document ${text(args.documentId)}`,
    subtitle: ONBASE,
    confirmLabel: 'Add note',
    editable: [{ key: 'text', label: 'Note', multiline: true }],
    body: {
      kind: 'comment',
      mode: 'note',
      on: ref(text(args.documentId), 'Document', text(args.noteType)),
      bodyKey: 'text',
      body: text(args.text) || '(the note type’s default text)',
      badges: [`Page ${text(args.page) || '1'}`, text(args.noteType)].filter(Boolean),
    },
  }),

  onbase_archive_document: (args) => ({
    verb: 'Archive',
    icon: 'upload',
    title: `Archive a document as ${text(args.documentType)}`,
    subtitle: ONBASE,
    confirmLabel: 'Archive document',
    body: {
      kind: 'change',
      subject: ref('Uploaded file', undefined, text(args.documentType)),
      rows: [
        { label: 'Document type', value: text(args.documentType) },
        ...keywordRows(args.keywords),
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

  onbase_reindex_document: (args) => ({
    verb: 'Reindex',
    tone: 'caution',
    icon: 'tag',
    title: `Reindex document ${text(args.documentId)} as ${text(args.targetDocumentType)}`,
    subtitle: ONBASE,
    confirmLabel: 'Reindex',
    body: {
      kind: 'change',
      subject: ref(text(args.documentId), 'Document'),
      rows: [
        { label: 'Document type', value: text(args.targetDocumentType) },
        ...(text(args.documentDate)
          ? [{ label: 'Document date', value: text(args.documentDate) }]
          : []),
        ...(text(args.comment) ? [{ label: 'Revision comment', value: text(args.comment) }] : []),
      ],
      notes: ['The document is filed under a different type, with that type’s permissions.'],
    },
  }),

  onbase_update_keywords: (args) => ({
    verb: 'Update',
    icon: 'tag',
    title: `Update the keywords on document ${text(args.documentId)}`,
    subtitle: ONBASE,
    confirmLabel: 'Update keywords',
    body: {
      kind: 'change',
      subject: ref(text(args.documentId), 'Document'),
      rows: keywordRows(args.keywords),
      notes: ['Each keyword shown is replaced by exactly the values listed.'],
    },
  }),

  onbase_admin_create_document_type: adminCreate('document type', 'name', []),
  onbase_admin_create_keyword_type: adminCreate('keyword type', 'name', []),
  onbase_admin_create_document_type_group: adminCreate('document type group', 'name', []),
  onbase_admin_create_keyword_type_group: (args) => ({
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
          add: records(args.keywordTypes).map(
            (entry) => text(entry.keywordType) || text(entry.name) || show(entry)
          ),
        },
        ...nameRows(args, ['name', 'keywordTypes']),
      ],
    },
  }),
  onbase_admin_create_file_type: adminCreate('file type', 'name', []),

  onbase_admin_update_document_type: (args) => ({
    verb: 'Update',
    tone: 'caution',
    icon: 'gear',
    title: `Update the document type ${text(args.documentType)}`,
    subtitle: `${ONBASE} · Administration`,
    confirmLabel: 'Update document type',
    body: {
      kind: 'change',
      subject: ref(text(args.documentType), 'Document type'),
      rows: Object.entries(record(args.fields)).map(([label, value]) => ({
        label,
        value: show(value),
      })),
      notes: ['Only the settings shown change.'],
    },
  }),

  onbase_admin_update_keyword_type: (args) => ({
    verb: 'Update',
    tone: 'caution',
    icon: 'gear',
    title: `Update the keyword type ${text(args.keywordType)}`,
    subtitle: `${ONBASE} · Administration`,
    confirmLabel: 'Update keyword type',
    body: {
      kind: 'change',
      subject: ref(text(args.keywordType), 'Keyword type'),
      rows: Object.entries(record(args.fields)).map(([label, value]) => ({
        label,
        value: show(value),
      })),
      notes: ['Only the settings shown change.'],
    },
  }),

  onbase_admin_assign_keyword_types: (args) => ({
    verb: 'Assign',
    tone: 'caution',
    icon: 'tag',
    title: `Change the keywords on the document type ${text(args.documentType)}`,
    subtitle: `${ONBASE} · Administration`,
    confirmLabel: 'Save assignments',
    body: {
      kind: 'change',
      subject: ref(text(args.documentType), 'Document type'),
      rows: [
        {
          label: 'Keyword types',
          add: records(args.assignments)
            .filter((entry) => !yes(entry.remove))
            .map((entry) => text(entry.keywordType)),
          remove: records(args.assignments)
            .filter((entry) => yes(entry.remove))
            .map((entry) => text(entry.keywordType)),
        },
      ],
    },
  }),

  onbase_admin_assign_document_type_user_groups: (args) => {
    const { add, remove } = groups(args.userGroups);
    return {
      verb: 'Change access',
      tone: 'caution',
      icon: 'users',
      title: `Change who can use the document type ${text(args.documentType)}`,
      subtitle: `${ONBASE} · Administration`,
      confirmLabel: 'Save access',
      body: {
        kind: 'change',
        subject: ref(text(args.documentType), 'Document type'),
        rows: [{ label: 'User groups', add, remove }],
      },
    };
  },

  onbase_admin_assign_document_type_group_user_groups: (args) => {
    const { add, remove } = groups(args.userGroups);
    return {
      verb: 'Change access',
      tone: 'caution',
      icon: 'users',
      title: `Change who can use the document type group ${text(args.documentTypeGroup)}`,
      subtitle: `${ONBASE} · Administration`,
      confirmLabel: 'Save access',
      body: {
        kind: 'change',
        subject: ref(text(args.documentTypeGroup), 'Document type group'),
        rows: [{ label: 'User groups', add, remove }],
      },
    };
  },
};
