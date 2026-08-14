'use client';

/**
 * The redaction settings form.
 *
 * Each detector is described by what it matches AND what it deliberately does
 * not, because the second half is what an admin needs in order to trust the
 * first. Someone who believes "dates of birth" means all dates will conclude
 * the feature is broken the first time a sprint date survives; someone who
 * reads "only when labelled" knows exactly what they are getting.
 */

import { useEffect, useState } from 'react';
import { formatIsGeneric } from '@renkei/redaction';

interface DetectorInfo {
  key: string;
  label: string;
  finds: string;
  /** The honest limit. Never omitted. */
  misses: string;
}

const DETECTORS: DetectorInfo[] = [
  {
    key: 'ssn',
    label: 'Social security numbers',
    finds: '123-45-6789, or nine digits written after “SSN”.',
    misses: 'Nine bare digits with no label — too many order and account numbers look the same.',
  },
  {
    key: 'card',
    label: 'Payment card numbers',
    finds: 'Card-length numbers that pass the Luhn checksum and carry a real issuer prefix.',
    misses: 'Long internal identifiers, which is the point — they are not cards.',
  },
  {
    key: 'mrn',
    label: 'Medical record numbers',
    finds:
      'Numbers written after “MRN”, “medical record number”, “chart #”, or a pattern you add below.',
    misses: 'Bare numbers. There is no universal MRN format, so an unlabelled number is a guess.',
  },
  {
    key: 'dob',
    label: 'Dates of birth',
    finds: 'Dates written after “DOB”, “date of birth”, or “born on”.',
    misses: 'Every other date. Created, updated, due and release dates are left alone.',
  },
  {
    key: 'patient_name',
    label: 'Patient names',
    finds: 'A name written directly after “Patient”, “pt”, “member”, or “client”.',
    misses:
      'A patient named in ordinary prose with no marker nearby. Colleagues, vendors and service-desk customers are deliberately never matched — this gateway is largely about their names.',
  },
  {
    key: 'phone',
    label: 'Phone numbers',
    finds: 'Numbers in common formats, including with country code.',
    misses:
      'Nothing much — which is why this is off by default. Signature blocks are full of ordinary work numbers.',
  },
];

interface Config {
  enabled: boolean;
  detectors: string[];
  mrnFormats: string[];
}

/** Validated rather than asserted — this crosses the network. */
function asConfig(value: unknown): Config | null {
  if (typeof value !== 'object' || value === null) return null;
  const enabled = 'enabled' in value ? value.enabled : undefined;
  const detectors = 'detectors' in value ? value.detectors : undefined;
  const formats = 'mrnFormats' in value ? value.mrnFormats : undefined;
  if (typeof enabled !== 'boolean' || !Array.isArray(detectors) || !Array.isArray(formats)) {
    return null;
  }
  return {
    enabled,
    detectors: detectors.filter((d): d is string => typeof d === 'string'),
    mrnFormats: formats.filter((p): p is string => typeof p === 'string'),
  };
}

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950';

export default function RedactionForm({ slug }: { slug: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [patternText, setPatternText] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const response = await fetch(`/api/admin/${slug}/redaction`);
      if (!response.ok || !live) return;
      const next = asConfig(await response.json());
      if (!next) return;
      setConfig(next);
      setPatternText(next.mrnFormats.join('\n'));
    })();
    return () => {
      live = false;
    };
  }, [slug]);

  async function save(update: Partial<Config>) {
    if (!config) return;
    setSaving(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/admin/${slug}/redaction`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String(body.error)
            : 'Could not save';
        setStatus(message);
        return;
      }
      setConfig({ ...config, ...update });
      setStatus('Saved');
    } finally {
      setSaving(false);
    }
  }

  if (!config) return <p className="text-sm text-gray-500">Loading…</p>;

  // A shape with no fixed text of its own matches anything else of that shape.
  // Said before saving, not discovered afterwards in a mangled tool result.
  const genericFormats = patternText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && formatIsGeneric(line));

  const toggle = (key: string) => {
    const next = config.detectors.includes(key)
      ? config.detectors.filter((d) => d !== key)
      : [...config.detectors, key];
    setConfig({ ...config, detectors: next });
    void save({ detectors: next });
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={config.enabled}
            disabled={saving}
            onChange={(e) => {
              setConfig({ ...config, enabled: e.target.checked });
              void save({ enabled: e.target.checked });
            }}
          />
          <span>
            <span className="font-medium">Filter tool results</span>
            <span className="block text-sm text-gray-600 dark:text-gray-400">
              Tool calls always run and always return. This only changes the text a model receives.
            </span>
          </span>
        </label>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          What to look for
        </h2>
        <div className="flex flex-col gap-2">
          {DETECTORS.map((detector) => (
            <label
              key={detector.key}
              className={`flex items-start gap-3 rounded-lg border p-3 ${
                config.enabled
                  ? 'border-gray-200 dark:border-gray-800'
                  : 'border-gray-100 opacity-50 dark:border-gray-900'
              }`}
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={config.detectors.includes(detector.key)}
                disabled={saving || !config.enabled}
                onChange={() => toggle(detector.key)}
              />
              <span>
                <span className="font-medium">{detector.label}</span>
                <span className="block text-sm text-gray-600 dark:text-gray-400">
                  {detector.finds}
                </span>
                <span className="block text-sm text-amber-700 dark:text-amber-500">
                  Does not catch: {detector.misses}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Record number formats
        </h2>
        <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
          One format per line, for record numbers your systems write without a label. Anything
          matching is replaced wherever it appears.
        </p>
        <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">
          Write the shape, not a regular expression:{' '}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-900">#</code> a digit,{' '}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-900">@</code> a letter,{' '}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-900">*</code> either, and{' '}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-900">{'{7}'}</code> or{' '}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-900">{'{6,8}'}</code> to repeat the
          one before it. Everything else matches itself. So{' '}
          <code className="rounded bg-gray-100 px-1 dark:bg-gray-900">MR-#######</code> matches
          MR-4417732.
        </p>
        <p className="mb-2 text-sm text-gray-500">
          Regular expressions are deliberately not accepted: one written the wrong way can occupy
          the server for minutes, and this setting is shared with every other organization on it.
        </p>
        <textarea
          className={`${inputClass} font-mono`}
          rows={4}
          spellCheck={false}
          value={patternText}
          disabled={saving || !config.enabled}
          onChange={(e) => setPatternText(e.target.value)}
          placeholder={'MR-#######'}
        />
        {genericFormats.length > 0 && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-500">
            {genericFormats.map((f) => `“${f}”`).join(', ')}{' '}
            {genericFormats.length === 1 ? 'has' : 'have'} no fixed text, so{' '}
            {genericFormats.length === 1 ? 'it' : 'they'} will also match anything else of that
            shape — invoice numbers, part numbers, a bare year-month like 2026-08. Include the
            literal part your record numbers carry, such as{' '}
            <code className="rounded bg-gray-100 px-1 dark:bg-gray-900">MR-</code>, where you can.
          </p>
        )}
        <button
          type="button"
          className="mt-2 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          disabled={saving || !config.enabled}
          onClick={() =>
            void save({
              mrnFormats: patternText
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            })
          }
        >
          Save patterns
        </button>
      </section>

      {status && (
        <p
          className={`text-sm ${
            status === 'Saved'
              ? 'text-green-700 dark:text-green-400'
              : 'text-red-700 dark:text-red-400'
          }`}
        >
          {status}
        </p>
      )}

      <section className="rounded-lg border border-gray-200 p-4 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-400">
        <p className="mb-2 font-medium text-gray-800 dark:text-gray-200">What this is not</p>
        <p>
          This is one control among several, not a compliance boundary. It does not stand in for a
          BAA, an access review, or a data-processing agreement. It only filters what passes through
          MCP tool results — the same data still flows through the provider APIs themselves and any
          other channel your organization runs. And it is pattern matching: it finds identifiers
          with a recognizable shape or an explicit label, and it will miss others.
        </p>
      </section>
    </div>
  );
}
