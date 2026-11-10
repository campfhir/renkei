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
import type { Names, PreviewBuilder } from './card';
import { clip, named, record, records, ref, show, text } from './card';

type Args = Record<string, unknown>;

/** "Salesforce · UAT" — the org asked for, or the person's default org. */
const where = (args: Args) => `Salesforce · ${text(args.org) || 'your org'}`;

/** Salesforce's own test for "this is an id, not a name" (15 or 18 characters). */
const isId = (value: string) => /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value);

/**
 * What a person calls a record: the name as they typed it, the name looked
 * up for an id, or "the record" — an id is a handle for the confirm call.
 */
function recordLabel(ref: string, names: Names): string {
  if (!isId(ref)) return ref;
  return named(names, 'record', ref) || 'the record';
}

/** A { object?, record } reference in words: "Account Acme", never "Account 001…". */
function recordName(value: Args, names: Names, object?: unknown): string {
  const of = text(value.object ?? object);
  const label = recordLabel(text(value.record), names);
  if (!of) return label;
  return label === 'the record' ? `${of} record` : `${of} ${label}`;
}

/** The record's own name where there is one, else a generic phrase. */
const recordTitle = (value: Args, names: Names, object?: unknown) =>
  recordLabel(text(value.record), names) === 'the record'
    ? text(value.object ?? object) || 'Record'
    : recordLabel(text(value.record), names);

function fieldRows(value: unknown, names: Names = {}): Row[] {
  return Object.entries(record(value)).map(([label, v]) => {
    // A lookup typed as an id reads as the record it points at.
    const shown =
      v === null
        ? '(cleared)'
        : typeof v === 'string' && isId(v.trim())
          ? recordLabel(v.trim(), names)
          : show(v);
    return { label, value: shown, block: shown.length > 80 };
  });
}

const CHECKED =
  'Values are checked against the object (types, picklists, required fields) when you confirm; a value Salesforce refuses changes nothing.';

const related = (args: Args, names: Names) =>
  records(args.relatedTo)
    .map((entry) => recordName(entry, names))
    .filter(Boolean);

/** A person given as an id (or a name): the looked-up name, the typed name, or a generic phrase. */
function personLabel(value: string, names: Names): string {
  if (!isId(value)) return value;
  return named(names, 'user', value) || 'a Salesforce user';
}

export const SALESFORCE_PREVIEWS: Record<string, PreviewBuilder> = {
  salesforce_request_admin_change: (args) => ({
    verb: 'Request',
    icon: 'doc',
    title: text(args.title) || 'Ask for a change to Salesforce',
    subtitle: where(args),
    confirmLabel: 'Send the request',
    body: {
      kind: 'change',
      subject: ref(text(args.title) || 'A change request', 'Request'),
      rows: [
        { label: 'Asking for', value: clip(text(args.description), 400), block: true },
        ...(text(args.reason) ? [{ label: 'Why', value: clip(text(args.reason), 200) }] : []),
      ],
      notes: [
        'Nothing changes in Salesforce. Operators who administer the org are told; one builds it as a proposal for Salesforce to validate and approves it, or declines it with a reason.',
      ],
    },
  }),

  salesforce_create_record: (args, names) => {
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
            ? [
                {
                  label: 'Record type',
                  value: isId(text(args.recordType))
                    ? named(names, 'recordType', args.recordType) || 'the selected record type'
                    : text(args.recordType),
                },
              ]
            : []),
          ...(text(parent.record) ? [{ label: 'Under', value: recordName(parent, names) }] : []),
          ...fieldRows(args.fields, names),
        ],
        notes: [CHECKED, 'The org’s own automation may set more fields when it saves.'],
      },
    };
  },

  salesforce_update_record: (args, names) => ({
    verb: 'Update',
    icon: 'doc',
    title: `Update ${recordName(args, names, args.object)}`,
    subtitle: where(args),
    confirmLabel: 'Update record',
    body: {
      kind: 'change',
      subject: ref(recordTitle(args, names, args.object), text(args.object) || 'Record'),
      rows: fieldRows(args.fields, names),
      notes: [
        CHECKED,
        'Saved only if nobody changed the record since it is read; otherwise nothing is written.',
      ],
    },
  }),

  salesforce_upsert_record: (args, names) => ({
    verb: 'Save',
    icon: 'doc',
    title: named(names, 'external', args.externalId)
      ? `Create or update ${text(args.object) || 'the record'} ${named(names, 'external', args.externalId)}`
      : `Create or update the ${text(args.object) || 'record'} matching its ${text(args.externalIdField) || 'external id'}`,
    subtitle: where(args),
    confirmLabel: 'Save record',
    body: {
      kind: 'change',
      subject: ref(
        named(names, 'external', args.externalId) ||
          `${text(args.object) || 'Record'} matching its ${text(args.externalIdField) || 'external id'}`,
        text(args.object) || 'Record'
      ),
      rows: fieldRows(args.fields, names),
      notes: [
        'Updates the record with that external id, or creates it when there is none.',
        CHECKED,
      ],
    },
  }),

  salesforce_relate_records: (args, names) => {
    const from = record(args.from);
    const to = record(args.to);
    return {
      verb: 'Relate',
      icon: 'link',
      title: `Relate ${recordName(from, names)} and ${recordName(to, names)}`,
      subtitle: where(args),
      confirmLabel: 'Relate records',
      body: {
        kind: 'link',
        mode: 'create',
        from: ref(recordTitle(from, names), text(from.object) || 'Record'),
        relation: text(args.junctionObject) ? `through ${text(args.junctionObject)}` : 'related to',
        to: ref(recordTitle(to, names), text(to.object) || 'Record'),
      },
    };
  },

  salesforce_log_activity: (args, names) => ({
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
        ...(related(args, names).length ? [{ label: 'About', add: related(args, names) }] : []),
        ...(text(args.notes)
          ? [{ label: 'Notes', value: clip(text(args.notes), 2000), block: true }]
          : []),
      ],
    },
  }),

  salesforce_create_task: (args, names) => ({
    verb: 'Assign',
    icon: 'flag',
    title: `Task: ${text(args.subject)}`,
    subtitle: where(args),
    confirmLabel: 'Create task',
    body: {
      kind: 'change',
      subject: ref(text(args.subject), 'Task'),
      rows: [
        { label: 'Assigned to', value: personLabel(text(args.assignee), names) || 'you' },
        ...(text(args.due) ? [{ label: 'Due', value: text(args.due) }] : []),
        ...(text(args.priority) ? [{ label: 'Priority', value: text(args.priority) }] : []),
        ...(related(args, names).length ? [{ label: 'About', add: related(args, names) }] : []),
        ...(text(args.notes)
          ? [{ label: 'Notes', value: clip(text(args.notes), 2000), block: true }]
          : []),
      ],
    },
  }),

  salesforce_add_note: (args, names) => ({
    verb: 'Add note',
    icon: 'comment',
    title: `Note on ${recordName(args, names, args.object)}`,
    subtitle: where(args),
    confirmLabel: 'Add note',
    body: {
      kind: 'comment',
      mode: 'note',
      on: ref(recordTitle(args, names, args.object), text(args.object) || 'Record'),
      body: `${text(args.title)}\n\n${clip(text(args.text))}`,
    },
  }),

  salesforce_attach_file: (args, names) => {
    const also = records(args.alsoOn).map((entry) => recordName(entry, names));
    return {
      verb: 'Attach',
      icon: 'upload',
      title: `Attach a file to ${recordName(args, names, args.object)}`,
      subtitle: where(args),
      confirmLabel: 'Attach file',
      body: {
        kind: 'fileop',
        mode: 'attach',
        items: [
          {
            name: text(args.title) || named(names, 'file', args.fileId) || 'The staged file',
            type: 'attachment',
          },
        ],
        to: { name: recordName(args, names, args.object) },
        ...(also.length ? { details: [{ label: 'Also shared to', value: also.join(', ') }] } : {}),
        note: 'Anyone who can see these records in Salesforce can open the file.',
      },
    };
  },
};
