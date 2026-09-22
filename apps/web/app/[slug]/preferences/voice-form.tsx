'use client';

/**
 * How the chat sounds to this person: whether replies are read aloud
 * unasked, in which voice, how fast, and whether voice mode hears which
 * language they speak or listens for a chosen one. The same preference
 * the chat's own speaker menu edits;
 * this is the long form of it. Rendered only when the org has a voice
 * service — the page leaves it out otherwise, so nobody is offered a
 * setting with nothing behind it.
 */

import { useEffect, useMemo, useState } from 'react';
import type { VoicePrefs } from '@renkei/user-prefs/prefs';
import type { VoiceInfo } from '@renkei/voice';
import { LoadingLine } from '@/components/skeleton';
import { localeLabel, previewLocale, voiceSpeaks } from '@/lib/voice/catalog';
import { voiceClient } from '@/lib/voice/client';
import { useVoicePreview } from '@/lib/voice/use-voice-preview';
import { LanguagePicker, VoicePicker } from '../chat/_components/voice-picker';
import { WAVE_ACCENTS } from '../chat/_components/voice-wave';
import { useCoachAnchor } from '@/components/coach-marks/anchor';

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
  const sample = useVoicePreview(tenantId, { rate: prefs.rate });

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

  const locale = prefs.locale ?? defaults.locale;
  const locales = useMemo(() => {
    const set = new Set((voices ?? []).map((voice) => voice.locale));
    set.add(defaults.locale);
    if (prefs.locale) set.add(prefs.locale);
    return [...set];
  }, [voices, defaults.locale, prefs.locale]);
  const chosenVoice = useMemo(
    () => (prefs.voice ? ((voices ?? []).find((voice) => voice.id === prefs.voice) ?? null) : null),
    [voices, prefs.voice]
  );
  const dirty = JSON.stringify(prefs) !== JSON.stringify(saved);
  const playing = sample.previewing === (prefs.voice ?? '');

  function change(next: VoicePrefs) {
    setPrefs(next);
    setStatus('idle');
  }

  function chooseLocale(next: string) {
    change({
      ...prefs,
      locale: next === defaults.locale ? null : next,
      // A voice that cannot speak the new language is dropped with it; a
      // multilingual one stays.
      voice: chosenVoice && voiceSpeaks(chosenVoice, next) ? prefs.voice : null,
    });
  }

  function chooseVoice(voice: VoiceInfo | null) {
    if (!voice) {
      change({ ...prefs, voice: null });
      return;
    }
    // A voice of another language brings its language along, since that
    // is what it will be speaking.
    const nextLocale = voiceSpeaks(voice, locale) ? locale : voice.locale;
    change({
      ...prefs,
      voice: voice.id,
      locale: nextLocale === defaults.locale ? null : nextLocale,
    });
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

  const anchor = useCoachAnchor('prefs-voice');
  return (
    <section
      aria-labelledby="voice-heading"
      {...anchor}
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <h3 id="voice-heading" className="font-semibold">
        Voice
      </h3>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        How the chat sounds when it reads a reply, and in a voice conversation. The speaker button
        in any chat changes the same settings, except the wave colours, which are chosen here.
      </p>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={prefs.autoPlay}
          onChange={(event) => change({ ...prefs, autoPlay: event.target.checked })}
        />
        Read every reply aloud as it arrives
      </label>
      <label className="mt-2 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={prefs.detectLanguage}
          onChange={(event) => change({ ...prefs, detectLanguage: event.target.checked })}
        />
        <span>
          <span className="block">Detect the language I speak</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            What you say in a voice conversation or dictate is understood in whatever language you
            said it, without choosing one first. Off, only the language below is listened for.
          </span>
        </span>
      </label>
      <label className="mt-2 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={prefs.pushToTalk}
          onChange={(event) => change({ ...prefs, pushToTalk: event.target.checked })}
        />
        <span>
          <span className="block">Press to talk in a voice conversation</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            Like a walkie-talkie: press Talk, speak, press Done. Nothing is sent while you pause to
            think, and ten seconds of silence ends a recording. Off, the microphone sends what you
            said once you pause.
          </span>
        </span>
      </label>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="block text-sm">
          <span className="block font-medium">Language</span>
          <LanguagePicker
            locales={locales}
            value={locale}
            defaultLocale={defaults.locale}
            onChange={chooseLocale}
            size="md"
          />
          <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
            {prefs.detectLanguage
              ? 'The language replies are spoken in, which voices lead the list, and what is listened for when your language cannot be told.'
              : 'The language replies are spoken in and voice mode listens for, and which voices lead the list.'}
          </span>
        </div>
        <div className="block text-sm">
          <span className="block font-medium">Voice</span>
          {voices === null ? (
            <LoadingLine size="xs" className="mt-2" label="Loading voices…" />
          ) : (
            <VoicePicker
              voices={voices}
              value={prefs.voice}
              defaultVoice={defaults.voice}
              locale={locale}
              onChange={chooseVoice}
              previewing={sample.previewing}
              onPreview={(voice) => sample.preview(voice.id, previewLocale(voice, locale))}
              size="md"
            />
          )}
          <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
            Search by name, language, country, or a word from the description; press play on a row
            to hear it. Choosing a voice of another language switches the language with it.
          </span>
          {voicesError ? (
            <span className="mt-1 block text-xs text-red-600 dark:text-red-400">{voicesError}</span>
          ) : null}
        </div>
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
          onClick={() => sample.preview(prefs.voice, locale)}
          title={playing ? 'Stop the sample' : `A sentence in ${localeLabel(locale)}`}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
        >
          {playing ? 'Stop' : 'Preview'}
        </button>
        {status === 'saved' ? <span className="text-sm text-green-700">Saved.</span> : null}
        {status === 'failed' ? (
          <span className="text-sm text-red-600 dark:text-red-400">Could not save.</span>
        ) : null}
        {sample.error ? (
          <span className="text-sm text-red-600 dark:text-red-400">{sample.error}</span>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Preview plays a sample sentence in {localeLabel(locale)}. Voices and samples are
        synthesized by our speech vendor, so pronunciation and accent can vary by language, voice,
        and dialect, and may not sound the way you expect.
      </p>
    </section>
  );
}
