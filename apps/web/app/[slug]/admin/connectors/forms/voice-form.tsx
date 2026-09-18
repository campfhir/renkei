'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  useConnectorConfig,
  putJson,
  Card,
  StatusPill,
  inputClass,
  labelClass,
  hintClass,
  SaveRow,
} from './shared';
import { LoadingRegion, SkeletonForm } from '@/components/skeleton';

/* ----------------------------------------------------------------------- */

interface VoiceConfigView {
  configured: boolean;
  enabled: boolean;
  provider: string;
  providers: string[];
  region: string | null;
  endpoint: string | null;
  defaultVoice: string;
  defaultLocale: string;
  hasApiKey: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  'azure-speech': 'Azure AI Speech',
};

/**
 * The voice connector: the speech service that reads replies aloud and
 * carries the chat's voice mode. Org-wide like web search — one region
 * (or a custom endpoint) and one key — and nothing about voice is offered
 * to anyone until this is saved and enabled.
 */
export function VoiceForm({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/voice`;
  const [state, reload] = useConnectorConfig<VoiceConfigView>(url);
  const [provider, setProvider] = useState('azure-speech');
  const [region, setRegion] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [defaultVoice, setDefaultVoice] = useState('');
  const [defaultLocale, setDefaultLocale] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setProvider(state.data.provider);
    setRegion(state.data.region ?? '');
    setEndpoint(state.data.endpoint ?? '');
    setDefaultVoice(state.data.defaultVoice);
    setDefaultLocale(state.data.defaultLocale);
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      provider,
      region: region.trim(),
      endpoint: endpoint.trim(),
      // Blank means keep the stored key — omit it from the payload.
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      defaultVoice: defaultVoice.trim(),
      defaultLocale: defaultLocale.trim(),
      enabled,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setApiKey('');
    setNotice('Saved');
    reload();
  }

  async function test() {
    setTesting(true);
    setNotice(null);
    setError(null);
    try {
      const response = await fetch(`${url}/test`, { method: 'POST' });
      const body: unknown = await response.json().catch(() => null);
      const record: Record<string, unknown> =
        typeof body === 'object' && body !== null ? { ...body } : {};
      if (!response.ok) {
        setError(
          typeof record.error === 'string' ? record.error : `Test failed (${response.status})`
        );
        return;
      }
      const voices = typeof record.voices === 'number' ? record.voices : 0;
      const locales = typeof record.locales === 'number' ? record.locales : 0;
      setNotice(
        `Connected: ${voices} voices in ${locales} languages.` +
          (record.defaultVoiceKnown === false
            ? ' The default voice is not one of them — check its name.'
            : '')
      );
    } catch {
      setError('Could not reach the server');
    } finally {
      setTesting(false);
    }
  }

  if (state.loading)
    return (
      <Card title="Voice" status={null}>
        <LoadingRegion label="Loading settings…">
          <SkeletonForm fields={3} />
        </LoadingRegion>
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Voice" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="Voice"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Speech for the chat: replies read aloud, and a voice mode where a person talks and listens
        instead of typing. One org-wide key; every sentence spoken and every utterance transcribed
        is a call to this service, and the reply text and the person&apos;s recorded speech leave
        for it. Until this is saved and enabled, nothing about voice is shown to anyone.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="voice-provider" className={labelClass}>
            Provider
          </label>
          <select
            id="voice-provider"
            className={inputClass}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {(config?.providers ?? ['azure-speech']).map((kind) => (
              <option key={kind} value={kind}>
                {PROVIDER_LABELS[kind] ?? kind}
              </option>
            ))}
          </select>
          <p className={hintClass}>
            The service behind the interface; Renkei speaks to it the same way whichever it is.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="voice-region" className={labelClass}>
              Region
            </label>
            <input
              id="voice-region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="eastus"
              className={`${inputClass} font-mono`}
            />
            <p className={hintClass}>
              The Speech resource&apos;s region, as Azure names it. Required unless a custom
              endpoint is set.
            </p>
          </div>
          <div>
            <label htmlFor="voice-endpoint" className={labelClass}>
              Custom endpoint <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <input
              id="voice-endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://{resource}.cognitiveservices.azure.com"
              className={`${inputClass} font-mono`}
            />
            <p className={hintClass}>
              A custom domain or private endpoint, used instead of the regional hosts.
            </p>
          </div>
        </div>
        <div>
          <label htmlFor="voice-key" className={labelClass}>
            API key
          </label>
          <input
            id="voice-key"
            type="password"
            required={!config?.hasApiKey}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.hasApiKey ? 'Stored — leave blank to keep' : ''}
            className={`${inputClass} font-mono`}
          />
          {config?.hasApiKey && (
            <p className={hintClass}>A key is stored but never shown; leave blank to keep it.</p>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="voice-default" className={labelClass}>
              Default voice
            </label>
            <input
              id="voice-default"
              value={defaultVoice}
              onChange={(e) => setDefaultVoice(e.target.value)}
              placeholder="en-US-AvaMultilingualNeural"
              className={`${inputClass} font-mono`}
            />
            <p className={hintClass}>
              What people hear until they pick a voice of their own under Preferences.
            </p>
          </div>
          <div>
            <label htmlFor="voice-locale" className={labelClass}>
              Default language
            </label>
            <input
              id="voice-locale"
              value={defaultLocale}
              onChange={(e) => setDefaultLocale(e.target.value)}
              placeholder="en-US"
              className={`${inputClass} font-mono`}
            />
            <p className={hintClass}>
              The language voice mode listens for, as a tag such as{' '}
              <code className="font-mono text-xs">en-US</code>. People can pick their own.
            </p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <SaveRow busy={busy} notice={notice} error={error} />
          {config?.configured ? (
            <button
              type="button"
              onClick={() => void test()}
              disabled={testing || busy}
              className="mt-4 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              {testing ? 'Testing…' : 'Test connection'}
            </button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
