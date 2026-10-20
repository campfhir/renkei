/** Preview cards for Zoom (meetings and docs) and Webex (notes). */

import type { PreviewBuilder } from './card';
import { ref, text, yes } from './card';
import { parseZoomRecurrence } from '../zoom/recurrence';

const ZOOM = 'Zoom';
const WEBEX = 'Webex';

function repeats(value: unknown, start: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = parseZoomRecurrence(value, start);
  return parsed.ok && parsed.val ? parsed.val.description : undefined;
}

export const MEETING_PREVIEWS: Record<string, PreviewBuilder> = {
  zoom_update_meeting: (args) => {
    const occurrence = text(args.occurrenceId);
    const recurrence =
      repeats(args.recurrence, text(args.startTime)) ??
      (yes(args.stopRepeating) ? 'no longer — the series ends' : undefined);
    return {
      verb: 'Update',
      icon: 'calendar',
      title: text(args.topic)
        ? `Update “${text(args.topic)}”`
        : `Update Zoom meeting ${text(args.meetingId)}`,
      subtitle: ZOOM,
      confirmLabel: 'Update meeting',
      editable:
        args.agenda === undefined ? [] : [{ key: 'agenda', label: 'Agenda', multiline: true }],
      body: {
        kind: 'event',
        mode: 'update',
        ...(text(args.topic) ? { subject: text(args.topic) } : {}),
        ...(text(args.startTime) ? { start: text(args.startTime) } : {}),
        ...(text(args.durationMinutes) ? { where: `${text(args.durationMinutes)} minutes` } : {}),
        ...(text(args.timezone) ? { timezone: text(args.timezone) } : {}),
        ...(recurrence ? { recurrence } : {}),
        online: true,
        scope: occurrence ? 'This occurrence only' : undefined,
        bodyKey: 'agenda',
        body: text(args.agenda),
        note: 'Only what is shown changes. Invitees see the new details.',
      },
    };
  },

  zoom_delete_meeting: (args) => {
    const occurrence = text(args.occurrenceId);
    return {
      verb: 'Cancel',
      tone: 'danger',
      icon: 'trash',
      title: occurrence
        ? `Cancel one occurrence of meeting ${text(args.meetingId)}`
        : `Delete Zoom meeting ${text(args.meetingId)}`,
      subtitle: ZOOM,
      confirmLabel: occurrence ? 'Cancel occurrence' : 'Delete meeting',
      body: {
        kind: 'event',
        mode: 'delete',
        subject: `Meeting ${text(args.meetingId)}`,
        online: true,
        scope: occurrence ? `Occurrence ${occurrence} only` : 'The whole meeting, every occurrence',
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

  zoom_append_to_doc: (args) => ({
    verb: 'Append',
    icon: 'doc',
    title: `Add to Zoom doc ${text(args.fileId)}`,
    subtitle: ZOOM,
    confirmLabel: 'Add to doc',
    editable: [{ key: 'text', label: 'Text to add', multiline: true }],
    body: {
      kind: 'document',
      mode: 'append',
      type: 'Zoom Doc',
      location: [`Doc ${text(args.fileId)}`],
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
