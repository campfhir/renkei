/**
 * Zoom meetings in the period: what was said, and what was written down.
 *
 * RAW TRANSCRIPTS ARE PREFERRED OVER ZOOM'S OWN MEETING SUMMARY, deliberately
 * and at some cost. Zoom's summary is already a lossy reading of the meeting;
 * feeding it to another model to summarize again compounds one model's
 * choices about what mattered with another's, and the things that go missing
 * first — a caveat, who objected, the sentence where the decision actually
 * turned — are exactly what a person reads a summary to find. The raw
 * transcript is longer and messier and it is the source.
 *
 * That costs size, so each transcript is capped and says it was capped. A
 * short meeting arrives whole; a long one arrives as its opening plus an
 * honest note, which is still better than a summary of a summary.
 *
 * Manual notes are included alongside rather than instead: someone who typed
 * a note during a call was recording what they thought mattered, which is
 * signal the transcript does not contain.
 */

import { resolveZoomAccess } from '../zoom/zoom-auth';
import type { MCPToolContext } from '../common';
import {
  clip,
  DETAIL_ITEM_MAX_CHARS,
  DETAIL_SECTION_MAX_CHARS,
  MAX_ITEMS_PER_SECTION,
  type SummaryPeriod,
  type SummarySection,
} from './types';

const ZOOM_API = 'https://api.zoom.us/v2';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function zoomGet(token: string, path: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${ZOOM_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  return isRecord(body) ? body : null;
}

/** VTT down to plain speech: cues and timings are scaffolding, not content. */
function vttToText(vtt: string): string {
  return vtt
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim() !== '' &&
        line.trim() !== 'WEBVTT' &&
        !/^\d+$/.test(line.trim()) &&
        !line.includes('-->')
    )
    .join('\n');
}

async function fetchTranscript(token: string, recording: Record<string, unknown>): Promise<string> {
  const files = Array.isArray(recording.recording_files) ? recording.recording_files : [];
  for (const raw of files) {
    const file = isRecord(raw) ? raw : {};
    if (str(file.file_type).toUpperCase() !== 'TRANSCRIPT') continue;
    const url = str(file.download_url);
    if (!url) continue;
    // The download URL needs the same bearer; Zoom rejects it unauthenticated.
    const response = await fetch(`${url}?access_token=${encodeURIComponent(token)}`).catch(
      () => null
    );
    if (!response || !response.ok) continue;
    const vtt = await response.text().catch(() => '');
    if (vtt) return vttToText(vtt);
  }
  return '';
}

export async function collectZoom(
  context: MCPToolContext,
  period: SummaryPeriod
): Promise<SummarySection | null> {
  const access = await resolveZoomAccess(context);
  if (typeof access === 'string') return null;

  const from = period.start.slice(0, 10);
  const to = period.end.slice(0, 10);
  const recordings = await zoomGet(
    access.accessToken,
    `/users/me/recordings?from=${from}&to=${to}&page_size=${MAX_ITEMS_PER_SECTION}`
  );

  const meetings = Array.isArray(recordings?.meetings) ? recordings.meetings : [];
  const lines: string[] = [];
  const details: string[] = [];
  let budget = DETAIL_SECTION_MAX_CHARS;
  let clippedAny = false;
  let withoutTranscript = 0;

  for (const raw of meetings) {
    const meeting = isRecord(raw) ? raw : {};
    const startedAt = str(meeting.start_time);
    // The recordings API is day-granular; this is the real bound.
    if (startedAt && (startedAt < period.start || startedAt >= period.end)) continue;

    const topic = str(meeting.topic) || '(untitled meeting)';
    const minutes = typeof meeting.duration === 'number' ? meeting.duration : null;
    lines.push(`${startedAt.slice(11, 16)} ${topic}${minutes ? ` (${minutes}m)` : ''}`);

    if (budget <= 0) continue;
    const transcript = await fetchTranscript(access.accessToken, meeting);
    if (!transcript) {
      withoutTranscript += 1;
      continue;
    }
    const piece = clip(transcript, Math.min(DETAIL_ITEM_MAX_CHARS, budget));
    if (piece.clipped) clippedAny = true;
    budget -= piece.text.length;
    details.push(`- ${topic} (transcript):\n${piece.text}`);
  }

  // Notes are a separate surface in Zoom, not part of a recording.
  const notes = await zoomGet(access.accessToken, `/notes?from=${from}&to=${to}`);
  const noteList = Array.isArray(notes?.notes) ? notes.notes : [];
  for (const raw of noteList) {
    const note = isRecord(raw) ? raw : {};
    const title = str(note.title) || '(untitled note)';
    lines.push(`note: ${title}`);
    const body = str(note.content) || str(note.summary);
    if (body && budget > 0) {
      const piece = clip(body, Math.min(DETAIL_ITEM_MAX_CHARS, budget));
      if (piece.clipped) clippedAny = true;
      budget -= piece.text.length;
      details.push(`- ${title} (note):\n${piece.text}`);
    }
  }

  if (lines.length === 0) return null;

  const notesAbout = [
    clippedAny && 'transcripts are truncated',
    withoutTranscript > 0 &&
      `${withoutTranscript} meeting${withoutTranscript === 1 ? ' has' : 's have'} no transcript`,
    'raw transcripts are used in preference to Zoom’s own summaries',
  ].filter((note): note is string => typeof note === 'string');

  return {
    connector: 'zoom',
    label: 'Zoom meetings & notes',
    headline: `${lines.length} item${lines.length === 1 ? '' : 's'}`,
    lines,
    detail: details.length > 0 ? `\n${details.join('\n\n')}` : undefined,
    omitted: notesAbout.join('; '),
  };
}
