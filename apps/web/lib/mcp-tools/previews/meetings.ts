/** Preview cards for Zoom (meetings and docs) and Webex (notes). */

import type { PreviewBuilder } from './card';
import { named, ref, text, yes } from './card';
import { parseZoomRecurrence } from '../zoom/recurrence';

const ZOOM = 'Zoom';
const WEBEX = 'Webex';

function repeats(value: unknown, start: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = parseZoomRecurrence(value, start);
  return parsed.ok && parsed.val ? parsed.val.description : undefined;
}

export const MEETING_PREVIEWS: Record<string, PreviewBuilder> = {
  zoom_update_meeting: (args, names) => {
    const occurrence = text(args.occurrenceId);
    const current = named(names, 'meeting', args.meetingId);
    const when = named(names, 'occurrence', occurrence);
    const recurrence =
      repeats(args.recurrence, text(args.startTime)) ??
      (yes(args.stopRepeating) ? 'no longer — the series ends' : undefined);
    return {
      verb: 'Update',
      icon: 'calendar',
      title: current
        ? `Update “${current}”`
        : text(args.topic)
          ? `Update “${text(args.topic)}”`
          : 'Update a Zoom meeting',
      subtitle: ZOOM,
      confirmLabel: 'Update meeting',
      editable:
        args.agenda === undefined ? [] : [{ key: 'agenda', label: 'Agenda', multiline: true }],
      body: {
        kind: 'event',
        mode: 'update',
        ...(text(args.topic) || current ? { subject: text(args.topic) || current } : {}),
        ...(text(args.startTime) ? { start: text(args.startTime) } : {}),
        ...(text(args.durationMinutes) ? { where: `${text(args.durationMinutes)} minutes` } : {}),
        ...(text(args.timezone) ? { timezone: text(args.timezone) } : {}),
        ...(recurrence ? { recurrence } : {}),
        online: true,
        scope: occurrence ? `This occurrence only${when ? ` (${when})` : ''}` : undefined,
        bodyKey: 'agenda',
        body: text(args.agenda),
        note: 'Only what is shown changes. Invitees see the new details.',
      },
    };
  },

  zoom_delete_meeting: (args, names) => {
    const occurrence = text(args.occurrenceId);
    const topic = named(names, 'meeting', args.meetingId);
    const when = named(names, 'occurrence', occurrence);
    return {
      verb: 'Cancel',
      tone: 'danger',
      icon: 'trash',
      title: occurrence
        ? `Cancel one occurrence of ${topic ? `“${topic}”` : 'a Zoom meeting'}`
        : `Delete ${topic ? `“${topic}”` : 'a Zoom meeting'}`,
      subtitle: ZOOM,
      confirmLabel: occurrence ? 'Cancel occurrence' : 'Delete meeting',
      body: {
        kind: 'event',
        mode: 'delete',
        subject: topic || 'The Zoom meeting',
        online: true,
        scope: occurrence
          ? `${when ? `The occurrence on ${when}` : 'One occurrence'} only`
          : 'The whole meeting, every occurrence',
        note:
          args.notifyRegistrants === false
            ? 'Registrants are not told.'
            : 'Registrants are told it is cancelled.',
      },
    };
  },

  zoom_create_doc: (args) => ({
    verb: 'Create',
    icon: 'doc',
    title: `Create the Zoom doc “${text(args.name)}”`,
    subtitle: ZOOM,
    confirmLabel: 'Create doc',
    editable: [
      { key: 'name', label: 'Name', multiline: false },
      { key: 'markdown', label: 'Content', multiline: true },
    ],
    body: {
      kind: 'document',
      mode: 'create',
      type: 'Zoom Doc',
      titleKey: 'name',
      title: text(args.name),
      bodyKey: 'markdown',
      body: text(args.markdown),
    },
  }),

  zoom_append_to_doc: (args, names) => ({
    verb: 'Append',
    icon: 'doc',
    title: named(names, 'doc', args.fileId)
      ? `Add to the Zoom doc “${named(names, 'doc', args.fileId)}”`
      : 'Add to a Zoom doc',
    subtitle: ZOOM,
    confirmLabel: 'Add to doc',
    editable: [{ key: 'text', label: 'Text to add', multiline: true }],
    body: {
      kind: 'document',
      mode: 'append',
      type: 'Zoom Doc',
      location: [named(names, 'doc', args.fileId) || 'The doc'],
      bodyKey: 'text',
      body: text(args.text),
      unchanged: 'What is already in the doc is not touched.',
    },
  }),

  webex_note_to_self: (args) => ({
    verb: 'Note',
    icon: 'comment',
    title: 'Send yourself a note on Webex',
    subtitle: WEBEX,
    confirmLabel: 'Send note',
    editable: [{ key: 'markdown', label: 'Note', multiline: true }],
    body: {
      kind: 'comment',
      mode: 'note',
      on: ref('Note to self', undefined, WEBEX),
      bodyKey: 'markdown',
      body: text(args.markdown),
      badges: ['Only you see this'],
    },
  }),
};
