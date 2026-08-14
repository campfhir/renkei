/**
 * The "Show details" rows for a result card.
 *
 * This replaced a `JSON.stringify(metadata, null, 2)`. That was a debug dump
 * on an end-user page: braces and quotes, keys like `spaceId` and `sourceAt`
 * that mean nothing outside this codebase, and — worst — a repeat of the title
 * already printed at the top of the same card.
 *
 * The rule here is that a row must tell the reader something the card does not
 * already show. Anything already on the face of the card is skipped, keys are
 * given words, and a value that is an object or an empty string is dropped
 * rather than rendered as `[object Object]`.
 */

export interface DetailRow {
  label: string;
  value: string;
}

/** Already visible on the card, or internal plumbing. */
const HIDDEN = new Set([
  'title',
  'subject',
  'topic',
  'webLink',
  'note_link',
  'join_url',
  'sourceAt',
  'source_at',
  'kind',
]);

/** Words for the keys connectors actually set. */
const LABELS: Record<string, string> = {
  project: 'Project',
  status: 'Status',
  spaceId: 'Space',
  space: 'Space',
  from: 'From',
  to: 'To',
  folder: 'Folder',
  room: 'Room',
  roomId: 'Room',
  meeting: 'Meeting',
  host: 'Host',
  driveId: 'Drive',
  itemId: 'Item',
  path: 'Path',
  name: 'Name',
  author: 'Author',
  provider: 'Source',
};

function humanize(key: string): string {
  const spaced = key
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

/** A metadata value worth printing, or null. */
function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    const parts = value.map(scalar).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  // Objects are plumbing at this level; `[object Object]` helps nobody.
  return null;
}

export function detailRows(hit: {
  provider: string;
  refId: string;
  distance: number;
  metadata: Record<string, unknown>;
}): DetailRow[] {
  const rows: DetailRow[] = [
    { label: 'Source', value: hit.provider },
    { label: 'Reference', value: hit.refId },
  ];

  for (const [key, value] of Object.entries(hit.metadata)) {
    if (HIDDEN.has(key)) continue;
    const rendered = scalar(value);
    if (!rendered) continue;
    rows.push({ label: LABELS[key] ?? humanize(key), value: rendered });
  }

  // Last, and named for what it means rather than as a bare number: a
  // distance is only meaningful next to the others in the list.
  rows.push({ label: 'Match distance', value: hit.distance.toFixed(3) });
  return rows;
}
