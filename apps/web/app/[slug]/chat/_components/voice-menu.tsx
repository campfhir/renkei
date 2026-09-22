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
 * server for an hour). Language and voice are searchable pickers
 * (voice-picker.tsx), grouped by language and region with this person's
 * language first, and any voice can be heard saying a sentence in its
 * language before it is chosen. Every change here is saved as this
 * person's preference at once, so the next chat sounds the same.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VoicePrefs } from '@renkei/user-prefs/prefs';
import type { VoiceInfo } from '@renkei/voice';
import { Icon, ICONS } from '@/components/icons';
import { LoadingLine } from '@/components/skeleton';
import { useDismiss } from '@/lib/use-dismiss';
import { localeLabel, previewLocale, voiceSpeaks } from '@/lib/voice/catalog';
import { voiceClient } from '@/lib/voice/client';
import { listAudioDevices, type AudioDevice } from '@/lib/voice/device-settings';
import { SpeechQueue, type SpeechQueueState } from '@/lib/voice/speech-queue';
import type { LevelSource } from '@/lib/voice/levels';
import { useVoicePreview } from '@/lib/voice/use-voice-preview';
import { LanguagePicker, VoicePicker } from './voice-picker';
import { VoiceWaveIcon, WAVE_ACCENTS } from './voice-wave';

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

export default function VoiceMenu({
  tenantId,
  prefs,
  defaults,
  queueState,
  levels,
  echoCancellation,
  microphone,
  audioOutput,
  onChange,
  onEchoCancellation,
  onMicrophone,
  onAudioOutput,
  onStopReading,
  onStartVoiceMode,
  onPrime,
  disabled,
}: {
  tenantId: string;
  prefs: VoicePrefs;
  defaults: { voice: string; locale: string };
  queueState: SpeechQueueState;
  /** Where the speaker's loudness is read from while reading; null when it cannot be measured. */
  levels: LevelSource | null;
  onChange: (next: VoicePrefs) => void;
  /** This device's echo-cancellation choice, and how to change it. */
  echoCancellation: boolean;
  onEchoCancellation: (on: boolean) => void;
  /** This device's microphone and speaker choices; null is the system default. */
  microphone: string | null;
  onMicrophone: (deviceId: string | null) => void;
  audioOutput: string | null;
  onAudioOutput: (deviceId: string | null) => void;
  onStopReading: () => void;
  onStartVoiceMode: () => void;
  /** Called from the click that turns sound on, to unlock playback. */
  onPrime: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<VoiceInfo[] | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [devices, setDevices] = useState<{
    microphones: AudioDevice[];
    outputs: AudioDevice[];
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);

  // The devices, named, each time the menu opens: a headset connected
  // since last time, or names that appeared once the microphone was allowed.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listAudioDevices().then((listed) => {
      if (!cancelled) setDevices(listed);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);
  const canChooseOutput = SpeechQueue.canChooseOutput();

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
    return [...set];
  }, [voices, defaults.locale, prefs.locale]);
  const chosenVoice = useMemo(
    () => (prefs.voice ? ((voices ?? []).find((voice) => voice.id === prefs.voice) ?? null) : null),
    [voices, prefs.voice]
  );
  // A sample plays through its own queue, after the reply's has been silenced.
  const sample = useVoicePreview(tenantId, {
    rate: prefs.rate,
    outputDevice: audioOutput,
    onBeforePlay: onStopReading,
  });
  const chooseLocale = (next: string) =>
    onChange({
      ...prefs,
      locale: next === defaults.locale ? null : next,
      // A voice that cannot speak the new language is dropped with it; a
      // multilingual one stays.
      voice: chosenVoice && voiceSpeaks(chosenVoice, next) ? prefs.voice : null,
    });
  const chooseVoice = (voice: VoiceInfo | null) => {
    if (!voice) {
      onChange({ ...prefs, voice: null });
      return;
    }
    // A voice of another language brings its language along, since that
    // is what it will be speaking.
    const nextLocale = voiceSpeaks(voice, locale) ? locale : voice.locale;
    onChange({
      ...prefs,
      voice: voice.id,
      locale: nextLocale === defaults.locale ? null : nextLocale,
    });
  };
  const reading = queueState !== 'idle';
  const deviceOptions = (list: AudioDevice[], chosen: string | null) =>
    // A chosen device that is not listed now stays listed, so the choice is
    // visible and can be dropped; it is the default until it is back.
    chosen && !list.some((device) => device.id === chosen)
      ? [...list, { id: chosen, label: 'Chosen device (not connected)' }]
      : list;

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
        className="relative flex items-center justify-center rounded-md p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
      >
        {reading ? (
          <VoiceWaveIcon levels={queueState === 'loading' ? null : levels} accent={prefs.accent} />
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
          className="absolute bottom-full left-0 z-40 mb-1 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-2 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900"
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
          <div className="px-2 py-1">
            <span className="block text-[11px] font-medium text-gray-500">Language</span>
            <LanguagePicker
              locales={locales}
              value={locale}
              defaultLocale={defaults.locale}
              onChange={chooseLocale}
              size="sm"
            />
          </div>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={prefs.detectLanguage}
            onClick={() => onChange({ ...prefs, detectLanguage: !prefs.detectLanguage })}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-blue-600 dark:text-blue-400">
              {prefs.detectLanguage ? (
                <Icon path={ICONS.check} className="h-4 w-4" strokeWidth={2.4} />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block">Detect the language I speak</span>
              <span className="block text-[11px] text-gray-500">
                {prefs.detectLanguage
                  ? 'Whatever language you say it in is understood as said.'
                  : `Only ${localeLabel(locale)} is listened for.`}
              </span>
            </span>
          </button>
          <div className="px-2 py-1">
            <span className="block text-[11px] font-medium text-gray-500">Voice</span>
            {voices === null ? (
              <LoadingLine size="xs" className="mt-1" label="Loading voices…" />
            ) : (
              <div className="flex items-start gap-1.5">
                <div className="min-w-0 flex-1">
                  <VoicePicker
                    voices={voices}
                    value={prefs.voice}
                    defaultVoice={defaults.voice}
                    locale={locale}
                    onChange={chooseVoice}
                    previewing={sample.previewing}
                    onPreview={(voice) => sample.preview(voice.id, previewLocale(voice, locale))}
                    size="sm"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => sample.preview(prefs.voice, locale)}
                  aria-pressed={sample.previewing === (prefs.voice ?? '')}
                  title={
                    sample.previewing === (prefs.voice ?? '')
                      ? 'Stop the sample'
                      : `Hear a sample in ${localeLabel(locale)}`
                  }
                  className="mt-0.5 flex shrink-0 items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
                >
                  <Icon
                    path={sample.previewing === (prefs.voice ?? '') ? ICONS.stop : ICONS.play}
                    className="h-3.5 w-3.5"
                  />
                  {sample.previewing === (prefs.voice ?? '') ? 'Stop' : 'Hear'}
                </button>
              </div>
            )}
            {voicesError ? (
              <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">
                {voicesError}
              </span>
            ) : null}
            {sample.error ? (
              <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">
                {sample.error}
              </span>
            ) : null}
          </div>
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
            role="menuitemcheckbox"
            aria-checked={echoCancellation}
            onClick={() => onEchoCancellation(!echoCancellation)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-blue-600 dark:text-blue-400">
              {echoCancellation ? (
                <Icon path={ICONS.check} className="h-4 w-4" strokeWidth={2.4} />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block">Cancel echo on this device</span>
              <span className="block text-[11px] text-gray-500">
                Lets you talk over a reply. Turn off if the assistant sounds one-sided or muffled
                while the microphone is open — a Bluetooth headset then keeps its stereo profile —
                and Stop cuts a reply short instead.
              </span>
            </span>
          </button>
          {devices && (devices.microphones.length > 0 || microphone) ? (
            <label className="block px-2 py-1">
              <span className="block text-[11px] font-medium text-gray-500">
                Microphone on this device
              </span>
              <select
                value={microphone ?? ''}
                onChange={(event) => onMicrophone(event.target.value || null)}
                className="mt-0.5 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                <option value="">System default</option>
                {deviceOptions(devices.microphones, microphone).map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {canChooseOutput && devices && (devices.outputs.length > 0 || audioOutput) ? (
            <label className="block px-2 py-1">
              <span className="block text-[11px] font-medium text-gray-500">
                Speaker on this device
              </span>
              <select
                value={audioOutput ?? ''}
                onChange={(event) => onAudioOutput(event.target.value || null)}
                className="mt-0.5 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                <option value="">System default</option>
                {deviceOptions(devices.outputs, audioOutput).map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {devices && devices.microphones.length === 0 && devices.outputs.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-gray-500">
              Devices are named here once the microphone has been used.
            </p>
          ) : null}
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
