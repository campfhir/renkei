/**
 * Preview cards for Outlook: calendar events and the mailbox. (Sending,
 * replying and forwarding mail, and cancelling an event, have hand-written
 * cards next to their tools.)
 *
 * A mailbox act names its messages by Graph id, which says nothing to a
 * person, so those cards say what will happen and to how many; the message
 * subjects are not in the arguments to show.
 */

import type { Attendee } from '@/lib/mcp-widgets/src/act-card';
import type { PreviewBuilder } from './card';
import { count, record, strings, text, yes } from './card';
import { parseRecurrence } from '../outlook/recurrence';

const OUTLOOK = 'Outlook';

function repeats(value: unknown, start: string, timezone: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = parseRecurrence(value, start, timezone);
  return parsed.ok && parsed.val ? parsed.val.description : undefined;
}

function attendeesOf(required: string[], optional: string[], removed: string[] = []): Attendee[] {
  return [
    ...required.map((name) => ({ name })),
    ...optional.map((name) => ({ name, optional: true })),
    ...removed.map((name) => ({ name, removed: true })),
  ];
}

export const OUTLOOK_PREVIEWS: Record<string, PreviewBuilder> = {
  outlook_create_event: (args) => ({
    verb: 'Create',
    icon: 'calendar',
    title: `Create the event “${text(args.subject)}”`,
    subtitle: OUTLOOK,
    confirmLabel: strings(args.requiredAttendees).length > 0 ? 'Create and invite' : 'Create event',
    editable: [
      { key: 'subject', label: 'Title', multiline: false },
      ...(args.body === undefined ? [] : [{ key: 'body', label: 'Description', multiline: true }]),
    ],
    body: {
      kind: 'event',
      mode: 'create',
      subject: text(args.subject),
      start: text(args.start),
      end: text(args.end),
      timezone: text(args.timezone) || 'UTC',
      where: text(args.location),
      online: yes(args.onlineMeeting),
      recurrence: repeats(args.recurrence, text(args.start), text(args.timezone) || 'UTC'),
      attendees: attendeesOf(strings(args.requiredAttendees), strings(args.optionalAttendees)),
      bodyKey: 'body',
      body: text(args.body),
      note:
        strings(args.requiredAttendees).length + strings(args.optionalAttendees).length > 0
          ? 'Everyone listed is sent an invitation.'
          : undefined,
    },
  }),

  outlook_update_event: (args) => {
    const added = attendeesOf(
      strings(args.addRequiredAttendees),
      strings(args.addOptionalAttendees),
      strings(args.removeAttendees)
    );
    const series = text(args.scope) === 'series';
    return {
      verb: 'Update',
      icon: 'calendar',
      title: text(args.subject) ? `Update “${text(args.subject)}”` : 'Update a calendar event',
      subtitle: OUTLOOK,
      confirmLabel: 'Update event',
      editable:
        args.body === undefined ? [] : [{ key: 'body', label: 'Description', multiline: true }],
      body: {
        kind: 'event',
        mode: 'update',
        ...(text(args.subject) ? { subject: text(args.subject) } : {}),
        ...(text(args.start) ? { start: text(args.start) } : {}),
        ...(text(args.end) ? { end: text(args.end) } : {}),
        ...(text(args.timezone) ? { timezone: text(args.timezone) } : {}),
        ...(text(args.location) ? { where: text(args.location) } : {}),
        ...(repeats(args.recurrence, text(args.start), text(args.timezone) || 'UTC')
          ? { recurrence: repeats(args.recurrence, text(args.start), text(args.timezone) || 'UTC') }
          : yes(args.stopRepeating)
            ? { recurrence: 'no longer — the series ends' }
            : {}),
        ...(added.length > 0 ? { attendees: added } : {}),
        scope: series
          ? 'Whole series'
          : text(args.scope) === 'occurrence'
            ? 'This occurrence only'
            : undefined,
        bodyKey: 'body',
        body: text(args.body),
        note: 'Only what is shown changes; the rest of the event stays as it is.',
      },
    };
  },

  outlook_respond_event: (args) => {
    const answer = text(args.response);
    const response =
      answer === 'accept' || answer === 'tentative' || answer === 'decline' ? answer : undefined;
    const verbs = { accept: 'Accept', tentative: 'Maybe', decline: 'Decline' } as const;
    const proposing = text(args.proposedStart) !== '';
    return {
      verb: response ? verbs[response] : 'Respond',
      tone: response === 'decline' ? 'danger' : response === 'accept' ? 'positive' : 'caution',
      icon: response === 'decline' ? 'cross' : 'check',
      title: `${response ? verbs[response] : 'Respond to'} an invitation`,
      subtitle: OUTLOOK,
      confirmLabel: `${response ? verbs[response] : 'Send response'}`,
      editable:
        args.comment === undefined
          ? []
          : [{ key: 'comment', label: 'Message to the organizer', multiline: true }],
      body: {
        kind: 'event',
        mode: 'respond',
        ...(response ? { response } : {}),
        ...(proposing
          ? {
              start: text(args.proposedStart),
              end: text(args.proposedEnd),
              timezone: text(args.timezone),
            }
          : {}),
        bodyKey: 'comment',
        body: text(args.comment),
        note: proposing
          ? 'You are also proposing the time shown, instead of the one invited.'
          : 'The organizer is told your answer.',
      },
    };
  },

  outlook_mark_message: (args) => ({
    verb: yes(args.isRead) ? 'Mark read' : 'Mark unread',
    icon: 'mail',
    title: yes(args.isRead) ? 'Mark a message as read' : 'Mark a message as unread',
    subtitle: OUTLOOK,
    confirmLabel: yes(args.isRead) ? 'Mark read' : 'Mark unread',
    body: { kind: 'mailbox', mode: yes(args.isRead) ? 'read' : 'unread', messages: '1 message' },
  }),

  outlook_flag_message: (args) => {
    const status = text(args.status);
    const mode = status === 'flagged' ? 'flag' : status === 'complete' ? 'complete' : 'unflag';
    return {
      verb: mode === 'flag' ? 'Flag' : mode === 'complete' ? 'Complete' : 'Clear flag',
      icon: 'flag',
      title:
        mode === 'flag'
          ? 'Flag a message for follow-up'
          : mode === 'complete'
            ? 'Mark a flagged message complete'
            : 'Clear the flag on a message',
      subtitle: OUTLOOK,
      confirmLabel:
        mode === 'flag' ? 'Flag message' : mode === 'complete' ? 'Mark complete' : 'Clear flag',
      body: { kind: 'mailbox', mode, messages: '1 message' },
    };
  },

  outlook_categorize_message: (args) => ({
    verb: 'Categorize',
    icon: 'tag',
    title: 'Change a message’s categories',
    subtitle: OUTLOOK,
    confirmLabel: 'Save categories',
    body: {
      kind: 'mailbox',
      mode: 'categorize',
      messages: '1 message',
      categories: {
        add: strings(args.add),
        remove: strings(args.remove),
        replace: strings(args.replace),
      },
    },
  }),

  outlook_move_message: (args) => ({
    verb: 'Move',
    icon: 'folder',
    title: `Move a message to ${text(args.destinationFolder)}`,
    subtitle: OUTLOOK,
    confirmLabel: 'Move message',
    body: {
      kind: 'mailbox',
      mode: 'move',
      messages: '1 message',
      to: text(args.destinationFolder),
    },
  }),

  outlook_create_mail_folder: (args) => ({
    verb: 'Create',
    icon: 'folder',
    title: `Create the mail folder ${text(args.displayName)}`,
    subtitle: OUTLOOK,
    confirmLabel: 'Create folder',
    body: {
      kind: 'mailbox',
      mode: 'folder-create',
      to: text(args.displayName),
      messages: text(args.parentFolderId)
        ? `Inside folder ${text(args.parentFolderId)}`
        : 'At the top of your mailbox',
    },
  }),

  outlook_rename_mail_folder: (args) => ({
    verb: 'Rename',
    icon: 'folder',
    title: `Rename a mail folder to ${text(args.displayName)}`,
    subtitle: OUTLOOK,
    confirmLabel: 'Rename folder',
    body: {
      kind: 'mailbox',
      mode: 'folder-rename',
      folder: `Folder ${text(args.folderId)}`,
      to: text(args.displayName),
    },
  }),

  outlook_delete_mail_folder: (args) => ({
    verb: 'Delete',
    tone: 'danger',
    icon: 'trash',
    title: 'Delete a mail folder',
    subtitle: OUTLOOK,
    confirmLabel: 'Delete folder',
    body: { kind: 'mailbox', mode: 'folder-delete', folder: `Folder ${text(args.folderId)}` },
  }),

  outlook_start_bulk_mail_job: (args) => {
    const action = text(args.action);
    const filters = record(args.filters);
    return {
      verb: 'Bulk',
      tone: 'caution',
      icon: 'mail',
      title: `${action === 'markRead' ? (args.isRead === false ? 'Mark unread' : 'Mark read') : action === 'flag' ? 'Flag' : action === 'categorize' ? 'Categorize' : action === 'move' ? 'Move' : 'Archive'} many messages`,
      subtitle: OUTLOOK,
      confirmLabel: 'Start job',
      body: {
        kind: 'mailbox',
        mode: 'bulk',
        messages:
          strings(args.messageIds).length > 0
            ? `${count(strings(args.messageIds).length, 'named message')}`
            : 'Every message matching the filters below',
        filters: [
          {
            label: 'Action',
            value:
              action === 'markRead'
                ? args.isRead === false
                  ? 'Mark unread'
                  : 'Mark read'
                : action,
          },
          ...(text(args.destinationFolder)
            ? [{ label: 'Into folder', value: text(args.destinationFolder) }]
            : []),
          ...(text(args.flagStatus) ? [{ label: 'Flag', value: text(args.flagStatus) }] : []),
          ...strings(args.add).map((value) => ({ label: 'Add category', value })),
          ...strings(args.remove).map((value) => ({ label: 'Remove category', value })),
          ...strings(args.replace).map((value) => ({ label: 'Set category', value })),
          ...Object.entries(filters).map(([label, value]) => ({
            label,
            value: typeof value === 'string' ? value : JSON.stringify(value),
          })),
        ],
      },
    };
  },
};
