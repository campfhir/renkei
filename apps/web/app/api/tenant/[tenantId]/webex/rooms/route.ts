/**
 * The WebEx spaces the caller belongs to, for the trigger-filter picker.
 *
 * A filter on `roomId` is useless if a person has to find the id
 * themselves: a WebEx room id is base64 of a URN, it appears nowhere in the
 * WebEx UI, and a typo produces a filter that silently never matches. So
 * this lists what they can actually see, and the picker stores the id
 * behind the title — the same reasoning as the watch picker next door.
 *
 * SEARCH IS DONE HERE, NOT BY WEBEX. The Rooms API takes `max` and
 * `sortBy` and nothing else — there is no query parameter — so a search is
 * a bounded page fetched and then filtered by title. The consequence is
 * real and worth stating: someone in more than LIST_MAX spaces may not find
 * a long-dormant one, which is why the field also accepts a pasted id.
 *
 * Deliberately not cached: which spaces someone is in changes without
 * Renkei being told, and a stale list here is a filter they cannot express.
 */

import { NextRequest, NextResponse } from 'next/server';
import { WebexClient } from '@renkei/connector-webex';
import { getSessionFromRequest } from '@/lib/session';
import { resolveWebexUserAccess } from '@/lib/webex-user-access';

/**
 * How deep to look. WebEx sorts by last activity, so this is "the 400 most
 * recently active spaces" — generous for a picker, and bounded so one
 * person's membership cannot make this route slow for everyone.
 */
const LIST_MAX = 400;

/** How many to hand back. More than this is a list nobody reads. */
const RESULT_MAX = 50;

export interface RoomOption {
  /** The opaque room id — what the filter stores and compares. */
  key: string;
  label: string;
  hint: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const access = await resolveWebexUserAccess(tenantId, session.subject);
  if (!access) {
    return NextResponse.json(
      { error: 'Connect WebEx first, then your spaces can be listed here.' },
      { status: 409 }
    );
  }

  const rooms = await new WebexClient(access.accessToken).listRooms(LIST_MAX);
  if (!rooms.ok) {
    return NextResponse.json(
      { error: 'WebEx could not list your spaces. Try again, or paste a space id.' },
      { status: 400 }
    );
  }

  const query = (request.nextUrl.searchParams.get('q') ?? '').trim().toLowerCase();
  const options: RoomOption[] = rooms.val
    .map((room) => ({
      key: room.id,
      // A direct message has no title of its own; naming it by the space it
      // is rather than dropping it keeps it selectable.
      label: room.title ?? (room.type === 'direct' ? 'Direct message' : 'Untitled space'),
      hint: room.type === 'direct' ? 'direct message' : 'group space',
    }))
    .filter((option) => !query || option.label.toLowerCase().includes(query))
    .slice(0, RESULT_MAX);

  return NextResponse.json({ options });
}
