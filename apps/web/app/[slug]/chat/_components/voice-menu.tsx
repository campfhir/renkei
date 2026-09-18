'use client';

/**
 * The voice control in the composer row: one speaker button that says
 * whether replies are being read (a dot when the preference is on, a
 * blinking wave while one is being read) and opens a menu with the
 * preference itself, the voice and pace and language this person hears,
 * and the way into the immersive voice conversation. Rendered only when
 * the org has a voice service; a person whose org has none never sees a
 * speaker at all.
 *
 * Voices come from the vendor the first time the menu opens (cached by the
 * server for an hour), grouped by language. Every change here is saved as
 * this person's preference at once, so the next chat sounds the same.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VoicePrefs } from '@renkei/user-prefs/prefs';
import type { VoiceInfo } from '@renkei/voice';
import { Icon, ICONS } from '@/components/icons';
import { LoadingLine } from '@/components/skeleton';
import { useDismiss } from '@/lib/use-dismiss';
import { voiceClient } from '@/lib/voice/client';
import type { SpeechQueueState } from '@/lib/voice/speech-queue';
import { VoiceWaveIcon, WAVE_ACCENTS } from './voice-wave';

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

/** A locale tag as a person reads it, using the browser's own names. */
export function localeLabel(locale: string): string {
  try {
    const names = new Intl.DisplayNames(undefined, { type: 'language' });
    return names.of(locale) ?? locale;
  } catch {
    return locale;
  }
}

export default function VoiceMenu({
  tenantId,
  prefs,
  defaults,
  queueState,
  outputLevel,
  onChange,
  onStopReading,
  onStartVoiceMode,
  onPrime,
  disabled,
}: {
  tenantId: string;
  prefs: VoicePrefs;
  defaults: { voice: string; locale: string };
  queueState: SpeechQueueState;
  /** The speaker's loudness while reading, 0–1; null when it cannot be measured. */
  outputLevel: number | null;
  onChange: (next: VoicePrefs) => void;
  onStopReading: () => void;
  onStartVoiceMode: () => void;
  /** Called from the click that turns sound on, to unlock playback. */
  onPrime: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<VoiceInfo[] | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);

  useEffect(() => {
    if (!open || voices !== null) return;
    void voiceClient.status(tenantId).then((result) => {
      if (!result.data) {
        setVoices([]);
        setVoicesError(result.error);
        return;
      }
      setVoices(result.data.voices);
      setVoicesError(result.data.voicesError ?? null);
    });
  }, [open, voices, tenantId]);

  const locale = prefs.locale ?? defaults.locale;
  const locales = useMemo(() => {
    const set = new Set((voices ?? []).map((voice) => voice.locale));
    set.add(defaults.locale);
    if (prefs.locale) set.add(prefs.locale);
    return [...set].sort();
  }, [voices, defaults.locale, prefs.locale]);
  // The picker shows the voices of the chosen language; the current voice
  // stays listed even if it belongs to another, so a choice is never hidden.
  const shownVoices = useMemo(
    () =>
      (voices ?? []).filter(
        (voice) =>
          voice.locale === locale ||
          voice.locale.startsWith(`${locale.split('-')[0]}-`) ||
          voice.id === prefs.voice
      ),
    [voices, locale, prefs.voice]
  );
  const reading = queueState !== 'idle';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          onPrime();
          setOpen((state) => !state);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Voice"
        title={
          reading ? 'Reading the reply aloud' : prefs.autoPlay ? 'Replies are read aloud' : 'Voice'
        }
        disabled={disabled}
        className="relative rounded-md p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
      >
        {reading ? (
          <VoiceWaveIcon
            level={queueState === 'speaking' ? outputLevel : null}
            accent={prefs.accent}
          />
        ) : (
          <Icon path={ICONS.speaker} className="h-5 w-5" />
        )}
        {prefs.autoPlay && !reading ? (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-blue-600 dark:bg-blue-400"
          />
        ) : null}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-40 mb-1 w-80 rounded-lg border border-gray-200 bg-white p-2 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
            Voice
          </p>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={prefs.autoPlay}
            onClick={() => {
              onPrime();
              onChange({ ...prefs, autoPlay: !prefs.autoPlay });
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-blue-600 dark:text-blue-400">
              {prefs.autoPlay ? (
                <Icon path={ICONS.check} className="h-4 w-4" strokeWidth={2.4} />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block">Read replies aloud</span>
              <span className="block text-[11px] text-gray-500">
                Each reply is spoken as it arrives, in every chat.
              </span>
            </span>
          </button>
          {reading ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onStopReading();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <Icon path={ICONS.stop} className="h-4 w-4 shrink-0 text-gray-500" />
              <span>Stop reading</span>
            </button>
          ) : null}
          <div className="my-1 border-t border-gray-200 dark:border-gray-800" />
          <label className="block px-2 py-1">
            <span className="block text-[11px] font-medium text-gray-500">Language</span>
            <select
              value={locale}
              onChange={(event) =>
                onChange({
                  ...prefs,
                  locale: event.target.value === defaults.locale ? null : event.target.value,
                  // A voice of another language is dropped with it.
                  voice:
                    prefs.voice &&
                    voices?.some(
                      (voice) => voice.id === prefs.voice && voice.locale === event.target.value
                    )
                      ? prefs.voice
                      : null,
                })
              }
              className="mt-0.5 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            >
              {locales.map((tag) => (
                <option key={tag} value={tag}>
                  {localeLabel(tag)} ({tag}){tag === defaults.locale ? ' · default' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block px-2 py-1">
            <span className="block text-[11px] font-medium text-gray-500">Voice</span>
            {voices === null ? (
              <LoadingLine size="xs" className="mt-1" label="Loading voices…" />
            ) : (
              <select
                value={prefs.voice ?? ''}
                onChange={(event) => onChange({ ...prefs, voice: event.target.value || null })}
                className="mt-0.5 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                <option value="">Default ({defaults.voice})</option>
                {shownVoices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name}
                    {voice.gender ? ` · ${voice.gender}` : ''}
                    {voice.locale !== locale ? ` · ${voice.locale}` : ''}
                  </option>
                ))}
              </select>
            )}
            {voicesError ? (
              <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">
                {voicesError}
              </span>
            ) : null}
          </label>
          <div className="px-2 py-1">
            <span className="block text-[11px] font-medium text-gray-500">Speed</span>
            <div className="mt-1 flex gap-1" role="radiogroup" aria-label="Speed">
              {SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  role="radio"
                  aria-checked={prefs.rate === speed}
                  onClick={() => onChange({ ...prefs, rate: speed })}
                  className={`flex-1 rounded-md border px-1 py-0.5 text-xs ${
                    prefs.rate === speed
                      ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                      : 'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800'
                  }`}
                >
                  {speed}×
                </button>
              ))}
            </div>
          </div>
          {(
            [
              { key: 'accent', label: 'Assistant wave' },
              { key: 'userAccent', label: 'Your wave' },
            ] as const
          ).map((row) => (
            <div key={row.key} className="px-2 py-1">
              <span className="block text-[11px] font-medium text-gray-500">{row.label}</span>
              <div className="mt-1 flex gap-1.5" role="radiogroup" aria-label={row.label}>
                {WAVE_ACCENTS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="radio"
                    aria-checked={prefs[row.key] === entry.id}
                    aria-label={entry.label}
                    title={entry.label}
                    onClick={() => onChange({ ...prefs, [row.key]: entry.id })}
                    className={`h-6 w-6 rounded-full border-2 ${
                      prefs[row.key] === entry.id
                        ? 'border-gray-900 dark:border-white'
                        : 'border-transparent hover:border-gray-400'
                    }`}
                    style={{
                      background:
                        entry.colors.length > 3
                          ? `conic-gradient(${entry.colors.join(', ')}, ${entry.colors[0]})`
                          : entry.colors[1],
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="my-1 border-t border-gray-200 dark:border-gray-800" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onPrime();
              setOpen(false);
              onStartVoiceMode();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <Icon path={ICONS.microphone} className="h-4 w-4 shrink-0 text-gray-500" />
            <span className="min-w-0 flex-1">
              <span className="block">Start a voice conversation</span>
              <span className="block text-[11px] text-gray-500">
                Talk instead of typing; interrupt whenever you like.
              </span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
