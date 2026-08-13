/**
 * Unread WebEx messages in the period.
 *
 * "Unread" is the hard part: WebEx exposes no unread flag on a message. What
 * it gives is `lastActivity` per room and, per membership, `lastSeenId` — the
 * last message that person actually looked at. So unread is derived: for each
 * room the caller is in, everything after their lastSeenId. That is the same
 * definition the WebEx client itself uses, rather than a guess based on time.
 *
 * Rooms are visited newest-activity first and capped, because a person in
 * eighty spaces would otherwise pay eighty round trips for a morning brief.
 * The cap is reported, since "you have nothing unread" and "I stopped
 * looking after ten rooms" are very different statements.
 */

import { resolveWebexAccess } from '../webex';
import type { MCPToolContext } from '../common';
import {
  clip,
  DETAIL_ITEM_MAX_CHARS,
  DETAIL_SECTION_MAX_CHARS,
  MAX_ITEMS_PER_SECTION,
  type SummaryPeriod,
  type SummarySection,
} from './types';

const WEBEX_API = 'https://webexapis.com/v1';

/** Rooms checked per summary; beyond this the cost outruns the value. */
const MAX_ROOMS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function webexGet(token: string, path: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${WEBEX_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  return isRecord(body) ? body : null;
}

function itemsOf(body: Record<string, unknown> | null): Record<string, unknown>[] {
  const items = body?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(isRecord);
}

export async function collectWebex(
  context: MCPToolContext,
  period: SummaryPeriod
): Promise<SummarySection | null> {
  const access = await resolveWebexAccess(context);
  if (typeof access === 'string') return null;
  const token = access.accessToken;

  const rooms = itemsOf(
    await webexGet(token, `/rooms?sortBy=lastactivity&max=${MAX_ROOMS}`)
  ).filter((room) => {
    const activity = str(room.lastActivity);
    return !activity || activity >= period.start;
  });
  if (rooms.length === 0) return null;

  const lines: string[] = [];
  const details: string[] = [];
  let budget = DETAIL_SECTION_MAX_CHARS;
  let clippedAny = false;
  let unreadTotal = 0;

  for (const room of rooms) {
    const roomId = str(room.id);
    if (!roomId) continue;

    // lastSeenId is per-membership and is WebEx's own notion of "read".
    const membership = itemsOf(
      await webexGet(
        token,
        `/memberships?roomId=${encodeURIComponent(roomId)}&personEmail=${encodeURIComponent(access.personEmail ?? '')}`
      )
    )[0];
    const lastSeenId = str(membership?.lastSeenId);

    const messages = itemsOf(
      await webexGet(
        token,
        `/messages?roomId=${encodeURIComponent(roomId)}&max=${MAX_ITEMS_PER_SECTION}`
      )
    );
    if (messages.length === 0) continue;

    // Newest first from the API; everything before lastSeenId is unread.
    const unread: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (lastSeenId && str(message.id) === lastSeenId) break;
      const created = str(message.created);
      if (created && (created < period.start || created >= period.end)) continue;
      unread.push(message);
    }
    if (unread.length === 0) continue;

    unreadTotal += unread.length;
    const roomTitle = str(room.title) || '(direct message)';
    lines.push(`${roomTitle} — ${unread.length} unread`);

    if (budget <= 0) continue;
    const rendered = unread
      .reverse()
      .map((message) => `  ${str(message.personEmail)}: ${str(message.text)}`)
      .join('\n');
    const piece = clip(rendered, Math.min(DETAIL_ITEM_MAX_CHARS, budget));
    if (piece.clipped) clippedAny = true;
    budget -= piece.text.length;
    details.push(`- ${roomTitle}:\n${piece.text}`);
  }

  if (lines.length === 0) return null;

  const notes = [
    clippedAny && 'message text is truncated',
    rooms.length >= MAX_ROOMS && `only the ${MAX_ROOMS} most recently active spaces were checked`,
  ].filter((note): note is string => typeof note === 'string');

  return {
    connector: 'webex',
    label: 'WebEx unread',
    headline: `${unreadTotal} message${unreadTotal === 1 ? '' : 's'} in ${lines.length} space${lines.length === 1 ? '' : 's'}`,
    lines,
    detail: details.length > 0 ? `\n${details.join('\n\n')}` : undefined,
    omitted: notes.length > 0 ? notes.join('; ') : undefined,
  };
}
