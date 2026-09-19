/**
 * Voice, in two numbers: how much was read aloud (text to speech, by the
 * character — what the vendor bills) and how much was said to the chat
 * (speech to text, by the second). Shared by My usage and Organization
 * usage, which differ only in whose numbers these are.
 */

import { formatTokens } from '@/lib/format-tokens';
import type { VoiceTotals } from '@/lib/usage/voice-usage';
import { formatDuration } from '@/lib/usage/voice-window';

export function VoiceUsageCard({
  totals,
  heading = 'Voice',
  hint,
}: {
  totals: VoiceTotals;
  heading?: string;
  hint: string;
}) {
  return (
    <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <h2 className="text-sm font-medium text-gray-700 dark:text-gray-300">{heading}</h2>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{hint}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900">
          <p className="text-xs tracking-wide text-gray-500 uppercase">Read aloud</p>
          <p className="text-2xl font-semibold tabular-nums">
            {formatTokens(totals.speech.characters)}
          </p>
          <p className="text-xs text-gray-500">
            characters · {totals.speech.calls.toLocaleString('en-US')} pieces
          </p>
        </div>
        <div className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900">
          <p className="text-xs tracking-wide text-gray-500 uppercase">Spoken</p>
          <p className="text-2xl font-semibold tabular-nums">
            {formatDuration(totals.transcription.audioMs)}
          </p>
          <p className="text-xs text-gray-500">
            of speech · {totals.transcription.calls.toLocaleString('en-US')} utterances
          </p>
        </div>
      </div>
    </section>
  );
}
