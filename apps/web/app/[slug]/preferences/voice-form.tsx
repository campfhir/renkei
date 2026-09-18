'use client';

/**
 * How the chat sounds to this person: whether replies are read aloud
 * unasked, in which voice, how fast, and which language voice mode
 * listens for. The same preference the chat's own speaker menu edits;
 * this is the long form of it. Rendered only when the org has a voice
 * service — the page leaves it out otherwise, so nobody is offered a
 * setting with nothing behind it.
 */

import { useEffect, useMemo, useState } from 'react';
import type { VoicePrefs } from '@renkei/user-prefs/prefs';
import type { VoiceInfo } from '@renkei/voice';
import { LoadingLine } from '@/components/skeleton';
import { voiceClient } from '@/lib/voice/client';
import { SpeechQueue } from '@/lib/voice/speech-queue';
import { localeLabel } from '../chat/_components/voice-menu';
import { WAVE_ACCENTS } from '../chat/_components/voice-wave';

const SAMPLE = 'Hello — this is how replies will sound in your chats.';

export default function VoiceForm({
  tenantId,
  initial,
  defaults,
}: {
  tenantId: string;
  initial: VoicePrefs;
  defaults: { voice: string; locale: string };
}) {
  const [prefs, setPrefs] = useState<VoicePrefs>(initial);
  const [saved, setSaved] = useState<VoicePrefs>(initial);
  const [voices, setVoices] = useState<VoiceInfo[] | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [queue, setQueue] = useState<SpeechQueue | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    void voiceClient.status(tenantId).then((result) => {
      if (!result.data) {
        setVoices([]);
        setVoicesError(result.error);
        return;
      }
      setVoices(result.data.voices);
      setVoicesError(result.data.voicesError ?? null);
    });
  }, [tenantId]);

  useEffect(() => {
    const created = new SpeechQueue(tenantId, setSampleError);
    const unsubscribe = created.subscribe((state) => setPlaying(state !== 'idle'));
    setQueue(created);
    return () => {
      unsubscribe();
      created.dispose();
    };
  }, [tenantId]);

  const locale = prefs.locale ?? defaults.locale;
  const locales = useMemo(() => {
    const set = new Set((voices ?? []).map((voice) => voice.locale));
    set.add(defaults.locale);
    if (prefs.locale) set.add(prefs.locale);
    return [...set].sort();
  }, [voices, defaults.locale, prefs.locale]);
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
  const dirty = JSON.stringify(prefs) !== JSON.stringify(saved);

  function change(next: VoicePrefs) {
    setPrefs(next);
    setStatus('idle');
  }

  async function save() {
    setStatus('saving');
    const result = await voiceClient.savePrefs(tenantId, prefs);
    if (result.error) {
      setStatus('failed');
      return;
    }
    setSaved(prefs);
    setStatus('saved');
  }

  function sample() {
    if (!queue) return;
    if (playing) {
      queue.stop();
      return;
    }
    setSampleError(null);
    queue.configure({ voice: prefs.voice, rate: prefs.rate, locale });
    queue.prime();
    queue.begin('sample');
    queue.enqueue(SAMPLE);
    queue.finish();
  }

  return (
    <section
      aria-labelledby="voice-heading"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <h3 id="voice-heading" className="font-semibold">
        Voice
      </h3>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        How the chat sounds when it reads a reply, and in a voice conversation. The speaker button
        in any chat changes the same settings.
      </p>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={prefs.autoPlay}
          onChange={(event) => change({ ...prefs, autoPlay: event.target.checked })}
        />
        Read every reply aloud as it arrives
      </label>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="block font-medium">Language</span>
          <select
            value={locale}
            onChange={(event) =>
              change({
                ...prefs,
                locale: event.target.value === defaults.locale ? null : event.target.value,
                voice:
                  prefs.voice &&
                  voices?.some(
                    (voice) => voice.id === prefs.voice && voice.locale === event.target.value
                  )
                    ? prefs.voice
                    : null,
              })
            }
            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            {locales.map((tag) => (
              <option key={tag} value={tag}>
                {localeLabel(tag)} ({tag}){tag === defaults.locale ? ' · default' : ''}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
            What voice mode listens for, and which voices are offered.
          </span>
        </label>
        <label className="block text-sm">
          <span className="block font-medium">Voice</span>
          {voices === null ? (
            <LoadingLine size="xs" className="mt-2" label="Loading voices…" />
          ) : (
            <select
              value={prefs.voice ?? ''}
              onChange={(event) => change({ ...prefs, voice: event.target.value || null })}
              className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
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
            <span className="mt-1 block text-xs text-red-600 dark:text-red-400">{voicesError}</span>
          ) : null}
        </label>
      </div>

      <label className="mt-3 block text-sm">
        <span className="block font-medium">Speed: {prefs.rate.toFixed(2)}×</span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          value={prefs.rate}
          onChange={(event) => change({ ...prefs, rate: Number(event.target.value) })}
          className="mt-1 w-full max-w-md"
        />
      </label>

      {(
        [
          {
            key: 'accent',
            label: 'Assistant wave',
            hint: 'The wave while a reply is read, and the bars beside the composer.',
          },
          {
            key: 'userAccent',
            label: 'Your wave',
            hint: 'The wave while you are heard in a conversation, and the bars while you dictate.',
          },
        ] as const
      ).map((row) => (
        <fieldset key={row.key} className="mt-3">
          <legend className="block text-sm font-medium">{row.label}</legend>
          <p className="text-xs text-gray-500 dark:text-gray-400">{row.hint}</p>
          <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={row.label}>
            {WAVE_ACCENTS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={prefs[row.key] === entry.id}
                onClick={() => change({ ...prefs, [row.key]: entry.id })}
                className={`flex items-center gap-2 rounded-full border px-2 py-1 text-sm ${
                  prefs[row.key] === entry.id
                    ? 'border-gray-900 dark:border-white'
                    : 'border-gray-300 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="h-4 w-4 rounded-full"
                  style={{
                    background:
                      entry.colors.length > 3
                        ? `conic-gradient(${entry.colors.join(', ')}, ${entry.colors[0]})`
                        : entry.colors[1],
                  }}
                />
                {entry.label}
              </button>
            ))}
          </div>
        </fieldset>
      ))}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === 'saving' || !dirty}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={sample}
          disabled={!queue}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          {playing ? 'Stop' : 'Hear a sample'}
        </button>
        {status === 'saved' ? <span className="text-sm text-green-700">Saved.</span> : null}
        {status === 'failed' ? (
          <span className="text-sm text-red-600 dark:text-red-400">Could not save.</span>
        ) : null}
        {sampleError ? (
          <span className="text-sm text-red-600 dark:text-red-400">{sampleError}</span>
        ) : null}
      </div>
    </section>
  );
}
