/**
 * The names behind the ids a Zoom act's preview card carries (see
 * ../lookup.ts): a meeting's topic, the date of one occurrence of it, a
 * doc's title. Each lookup is one read and only reads; a failure just leaves
 * the name out, and the card then says "a Zoom meeting" rather than an id.
 */

import { encodeZoomMeetingId } from '@renkei/connector-zoom';
import type { MCPToolContext } from '../common';
import { registerPreviewLookups } from '../lookup';
import { nameKey, record, records, text, type Args, type Names } from '../previews/card';
import type { ZoomAuth } from './zoom-auth';

export function registerZoomPreviewLookups(
  context: MCPToolContext,
  auth: ZoomAuth,
  scopeFor: (tool: string) => string[]
): void {
  const get = async (tool: string, path: string): Promise<Args | null> => {
    try {
      const response = await auth.fetch(scopeFor(tool), path, { method: 'GET' });
      if (!response.ok) return null;
      return record(await response.json());
    } catch {
      return null;
    }
  };

  const meeting = async (args: Args): Promise<Names> => {
    const id = text(args.meetingId);
    if (!id) return {};
    const found = await get('zoom_get_meeting', `/meetings/${encodeZoomMeetingId(id)}`);
    if (!found) return {};
    const occurrence = text(args.occurrenceId);
    const start = occurrence
      ? text(
          records(found.occurrences).find((o) => text(o.occurrence_id) === occurrence)?.start_time
        )
      : '';
    return {
      ...(text(found.topic) ? { [nameKey('meeting', id)]: text(found.topic) } : {}),
      ...(start ? { [nameKey('occurrence', occurrence)]: start } : {}),
    };
  };

  registerPreviewLookups(context, {
    zoom_update_meeting: meeting,
    zoom_delete_meeting: meeting,
    zoom_append_to_doc: async (args) => {
      const id = text(args.fileId);
      if (!id) return {};
      const found = await get('zoom_get_doc', `/docs/files/${encodeURIComponent(id)}/content`);
      return text(found?.file_name) ? { [nameKey('doc', id)]: text(found?.file_name) } : {};
    },
  });
}
