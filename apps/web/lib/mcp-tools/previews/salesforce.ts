/**
 * Preview cards for the Salesforce CRM writes: one record created, updated
 * or upserted, two records related, an activity logged, a task assigned, a
 * note added, a staged file attached. The bulk writes, deletes and owner
 * changes have hand-written preview/confirm pairs next to their tools
 * (salesforce/bulk.ts), which resolve the records first.
 *
 * Builders do no I/O, so a card shows the record as the person named it and
 * the values as they were given — names, labels and lookups are resolved,
 * and every value checked against the org's describe, when the tool runs on
 * confirm. Which org the write lands in is on every card.
 */

import type { Row } from '@/lib/mcp-widgets/src/act-card';
import type { PreviewBuilder } from './card';
import { clip, record, records, ref, show, text } from './card';

type Args = Record<string, unknown>;

/** "Salesforce · UAT" — the org asked for, or the person's default org. */
const where = (args: Args) => `Salesforce · ${text(args.org) || 'your org'}`;

/** A { object?, record } reference in words. */
function recordName(value: Args, object?: unknown): string {
  const named = text(value.record);
  const of = text(value.object ?? object);
  return of ? `${of} ${named}` : named;
}

function fieldRows(value: unknown): Row[] {
  return Object.entries(record(value)).map(([label, v]) => {
    const shown = v === null ? '(cleared)' : show(v);
    return { label, value: shown, block: shown.length > 80 };
  });
}

const CHECKED =
  'Values are checked against the object (types, picklists, required fields) when you confirm; a value Salesforce refuses changes nothing.';

const related = (args: Args) =>
  records(args.relatedTo)
    .map((entry) => recordName(entry))
    .filter(Boolean);

export const SALESFORCE_PREVIEWS: Record<string, PreviewBuilder> = {
  salesforce_create_record: (args) => {
    const object = text(args.object);
    const parent = record(args.parent);
    return {
      verb: 'Create',
      icon: 'doc',
      title: `Create a ${object || 'record'}`,
      subtitle: where(args),
      confirmLabel: `Create ${object || 'record'}`,
      body: {
        kind: 'change',
        subject: ref(object || 'New record', 'New record'),
        rows: [
          ...(text(args.recordType)
            ? [{ label: 'Record type', value: text(args.recordType) }]
            : []),
          ...(text(parent.record) ? [{ label: 'Under', value: recordName(parent) }] : []),
          ...fieldRows(args.fields),
        ],
        notes: [CHECKED, 'The org’s own automation may set more fields when it saves.'],
      },
    };
  },

  salesforce_update_record: (args) => ({
    verb: 'Update',
    icon: 'doc',
    title: `Update ${recordName(args, args.object)}`,
    subtitle: where(args),
    confirmLabel: 'Update record',
    body: {
      kind: 'change',
      subject: ref(text(args.record), text(args.object) || 'Record'),
      rows: fieldRows(args.fields),
      notes: [
        CHECKED,
        'Saved only if nobody changed the record since it is read; otherwise nothing is written.',
      ],
    },
  }),

  salesforce_upsert_record: (args) => ({
    verb: 'Save',
    icon: 'doc',
    title: `Create or update the ${text(args.object) || 'record'} with ${text(args.externalIdField)} ${text(args.externalId)}`,
    subtitle: where(args),
    confirmLabel: 'Save record',
    body: {
      kind: 'change',
      subject: ref(
        `${text(args.externalIdField)} = ${text(args.externalId)}`,
        text(args.object) || 'Record'
      ),
      rows: fieldRows(args.fields),
      notes: [
        'Updates the record with that external id, or creates it when there is none.',
        CHECKED,
      ],
    },
  }),

  salesforce_relate_records: (args) => {
    const from = record(args.from);
    const to = record(args.to);
    return {
      verb: 'Relate',
      icon: 'link',
      title: `Relate ${recordName(from)} and ${recordName(to)}`,
      subtitle: where(args),
      confirmLabel: 'Relate records',
      body: {
        kind: 'link',
        mode: 'create',
        from: ref(text(from.record), text(from.object) || 'Record'),
        relation: text(args.junctionObject) ? `through ${text(args.junctionObject)}` : 'related to',
        to: ref(text(to.record), text(to.object) || 'Record'),
      },
    };
  },

  salesforce_log_activity: (args) => ({
    verb: 'Log',
    icon: 'clock',
    title: `Log a ${text(args.kind) || 'activity'}: ${text(args.subject)}`,
    subtitle: where(args),
    confirmLabel: 'Log activity',
    body: {
      kind: 'change',
      subject: ref(text(args.subject), 'Completed activity'),
      rows: [
        { label: 'What', value: text(args.kind) || 'other' },
        { label: 'When', value: text(args.date) || 'today' },
        ...(related(args).length ? [{ label: 'About', add: related(args) }] : []),
        ...(text(args.notes)
          ? [{ label: 'Notes', value: clip(text(args.notes), 2000), block: true }]
          : []),
      ],
    },
  }),

  salesforce_create_task: (args) => ({
    verb: 'Assign',
    icon: 'flag',
    title: `Task: ${text(args.subject)}`,
    subtitle: where(args),
    confirmLabel: 'Create task',
    body: {
      kind: 'change',
      subject: ref(text(args.subject), 'Task'),
      rows: [
        { label: 'Assigned to', value: text(args.assignee) || 'you' },
        ...(text(args.due) ? [{ label: 'Due', value: text(args.due) }] : []),
        ...(text(args.priority) ? [{ label: 'Priority', value: text(args.priority) }] : []),
        ...(related(args).length ? [{ label: 'About', add: related(args) }] : []),
        ...(text(args.notes)
          ? [{ label: 'Notes', value: clip(text(args.notes), 2000), block: true }]
          : []),
      ],
    },
  }),

  salesforce_add_note: (args) => ({
    verb: 'Add note',
    icon: 'comment',
    title: `Note on ${recordName(args, args.object)}`,
    subtitle: where(args),
    confirmLabel: 'Add note',
    body: {
      kind: 'comment',
      mode: 'note',
      on: ref(text(args.record), text(args.object) || 'Record'),
      body: `${text(args.title)}\n\n${clip(text(args.text))}`,
    },
  }),

  salesforce_attach_file: (args) => {
    const also = records(args.alsoOn).map((entry) => recordName(entry));
    return {
      verb: 'Attach',
      icon: 'upload',
      title: `Attach a file to ${recordName(args, args.object)}`,
      subtitle: where(args),
      confirmLabel: 'Attach file',
      body: {
        kind: 'fileop',
        mode: 'attach',
        items: [{ name: text(args.title) || text(args.fileId), type: 'attachment' }],
        to: { name: recordName(args, args.object) },
        ...(also.length ? { details: [{ label: 'Also shared to', value: also.join(', ') }] } : {}),
        note: 'Anyone who can see these records in Salesforce can open the file.',
      },
    };
  },
};
