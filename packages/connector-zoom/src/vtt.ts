/**
 * WebVTT → plain text, for Zoom cloud-recording transcripts.
 *
 * Zoom's transcript VTT carries one utterance per cue, with the speaker
 * inline as `Speaker Name: words`. Those labels ARE the transcript's
 * attribution, so text lines are kept verbatim — only the VTT scaffolding
 * (header, cue sequence numbers, `-->` timing lines) is dropped. Timing is
 * deliberately discarded: downstream consumers index and summarize prose,
 * and offsets would only be noise there.
 */

/** Strip WebVTT scaffolding, keeping cue text lines verbatim. */
export function vttToText(vtt: string): string {
  const kept: string[] = [];
  for (const line of vtt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('WEBVTT')) continue;
    if (trimmed.includes('-->')) continue;
    // Bare integers are cue sequence numbers, never utterances.
    if (/^\d+$/.test(trimmed)) continue;
    kept.push(trimmed);
  }
  return kept
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
