/**
 * Calendar and unread mail for the period.
 *
 * Two sections rather than one, because they answer different questions —
 * "what am I walking into" and "what is waiting for me" — and a reader scans
 * for one or the other.
 *
 * The unread COUNT is fetched separately from the messages themselves, and
 * that separation is the point: a summary that lists five previews from an
 * inbox of ninety and reports "5 unread" is worse than useless. The count is
 * exact and the previews are a sample, and the section says which is which.
 */

import { resolveGraphAccess, graphGet, values, str, rec } from '../graph/client';
import type { MCPToolContext } from '../common';
import {
  clip,
  DETAIL_ITEM_MAX_CHARS,
  MAX_ITEMS_PER_SECTION,
  type SummaryPeriod,
  type SummarySection,
} from './types';

/** Graph wants unquoted ISO in $filter, and rejects the trailing Z on some paths. */
function graphInstant(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

export async function collectCalendar(
  context: MCPToolContext,
  period: SummaryPeriod
): Promise<SummarySection | null> {
  const access = await resolveGraphAccess(context);
  if (typeof access === 'string') return null;

  // calendarView, not /events: it expands recurring series into the actual
  // occurrences in the window, where /events would return the series master
  // and miss today's instance entirely.
  const result = await graphGet(
    context,
    access.accessToken,
    `/me/calendarView?startDateTime=${graphInstant(period.start)}` +
      `&endDateTime=${graphInstant(period.end)}` +
      `&$select=subject,start,end,location,organizer,attendees,isAllDay,isCancelled,onlineMeetingUrl` +
      `&$orderby=start/dateTime&$top=${MAX_ITEMS_PER_SECTION}`,
    { Prefer: `outlook.timezone="${period.timeZone}"` }
  );
  if (!result.ok) {
    return { connector: 'microsoft', label: 'Calendar', lines: [], omitted: result.error };
  }

  const events = values(result.body).filter((event) => event.isCancelled !== true);
  if (events.length === 0) return null;

  const lines = events.map((event) => {
    const start = str(rec(event.start).dateTime).slice(11, 16);
    const end = str(rec(event.end).dateTime).slice(11, 16);
    const when = event.isAllDay === true ? 'all day' : `${start}–${end}`;
    const organizer = str(rec(rec(event.organizer).emailAddress).name);
    const attendees = Array.isArray(event.attendees) ? event.attendees.length : 0;
    const where = str(rec(event.location).displayName);
    const online = str(event.onlineMeetingUrl) ? ' (online)' : '';
    const bits = [
      organizer && `organizer ${organizer}`,
      attendees > 0 && `${attendees} attendee${attendees === 1 ? '' : 's'}`,
      where,
    ].filter(Boolean);
    return `${when} ${str(event.subject) || '(no subject)'}${online}${bits.length ? ` — ${bits.join(', ')}` : ''}`;
  });

  return {
    connector: 'microsoft',
    label: 'Calendar',
    headline: `${events.length} event${events.length === 1 ? '' : 's'}`,
    lines,
  };
}

export async function collectUnreadMail(
  context: MCPToolContext,
  period: SummaryPeriod
): Promise<SummarySection | null> {
  const access = await resolveGraphAccess(context);
  if (typeof access === 'string') return null;

  // receivedDateTime leads the filter because it is also the $orderby, and
  // Exchange rejects the combination otherwise with InefficientFilter — a
  // clause-order rule that only bites once the restriction gets complex.
  const filter =
    `receivedDateTime ge ${graphInstant(period.start)} and ` +
    `receivedDateTime lt ${graphInstant(period.end)} and isRead eq false`;

  const result = await graphGet(
    context,
    access.accessToken,
    `/me/mailFolders('inbox')/messages?$filter=${encodeURIComponent(filter)}` +
      `&$orderby=receivedDateTime desc&$top=${MAX_ITEMS_PER_SECTION}&$count=true` +
      `&$select=subject,from,receivedDateTime,bodyPreview,importance,hasAttachments`,
    // $count on a filtered mail query needs the eventual-consistency header.
    { ConsistencyLevel: 'eventual' }
  );
  if (!result.ok) {
    return { connector: 'microsoft', label: 'Unread mail', lines: [], omitted: result.error };
  }

  const messages = values(result.body);
  if (messages.length === 0) return null;

  // The exact figure, not the page size — a sample described as the whole is
  // the failure this guards against.
  const total =
    typeof result.body['@odata.count'] === 'number' ? result.body['@odata.count'] : messages.length;

  const lines: string[] = [];
  const details: string[] = [];
  for (const message of messages) {
    const from =
      str(rec(rec(message.from).emailAddress).name) ||
      str(rec(rec(message.from).emailAddress).address);
    const when = str(message.receivedDateTime).slice(11, 16);
    const flags = [
      str(message.importance) === 'high' && 'high importance',
      message.hasAttachments === true && 'attachment',
    ].filter(Boolean);
    lines.push(
      `${when} ${from}: ${str(message.subject) || '(no subject)'}${flags.length ? ` [${flags.join(', ')}]` : ''}`
    );
    const preview = clip(str(message.bodyPreview), DETAIL_ITEM_MAX_CHARS);
    if (preview.text) details.push(`- ${str(message.subject)}: ${preview.text}`);
  }

  return {
    connector: 'microsoft',
    label: 'Unread mail',
    headline: `${total} unread`,
    lines,
    detail:
      details.length > 0 ? `\n  Previews:\n${details.map((d) => `  ${d}`).join('\n')}` : undefined,
    omitted:
      total > messages.length
        ? `showing the ${messages.length} most recent of ${total} unread; previews are truncated`
        : undefined,
  };
}
