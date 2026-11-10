'use client';

import { FormEvent, useEffect, useReducer } from 'react';
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
import { reportFetchFailure } from '@/lib/fetch-json';
import {
  PROVIDER_LABELS,
  canTest,
  initialVoiceForm,
  saveBody,
  testOutcome,
  voiceFormReducer,
  type VoiceConfigView,
} from './voice-form.model';

/**
 * The voice connector: the speech service that reads replies aloud and
 * carries the chat's voice mode. Org-wide like web search — one region
 * (or a custom endpoint) and one key — and nothing about voice is offered
 * to anyone until this is saved and enabled.
 */
export function VoiceForm() {
  const url = `/api/admin/connectors/voice`;
  const [state, reload] = useConnectorConfig<VoiceConfigView>(url);
  const [form, dispatch] = useReducer(voiceFormReducer, initialVoiceForm);
  const { busy, testing, notice, error } = form;
  const { provider, region, endpoint, apiKey, defaultVoice, defaultLocale, enabled } = form.fields;

  useEffect(() => {
    if (state.data) dispatch({ type: 'loaded', config: state.data });
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    dispatch({ type: 'saving' });
    const failure = await putJson(url, saveBody(form.fields));
    if (failure) {
      dispatch({ type: 'save-failed', error: failure });
      return;
    }
    dispatch({ type: 'saved' });
    reload();
  }

  async function test() {
    dispatch({ type: 'testing' });
    try {
      const response = await fetch(`${url}/test`, { method: 'POST' });
      const body: unknown = await response.json().catch(() => null);
      const outcome = testOutcome(response.status, response.ok, body);
      if (outcome.type === 'test-failed') {
        reportFetchFailure('POST', `${url}/test`, response.status, outcome.error);
      }
      dispatch(outcome);
    } catch (error) {
      reportFetchFailure('POST', `${url}/test`, 0, 'Could not reach the server', error);
      dispatch({ type: 'test-failed', error: 'Could not reach the server' });
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
            onChange={(e) => dispatch({ type: 'edit', patch: { provider: e.target.value } })}
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
              onChange={(e) => dispatch({ type: 'edit', patch: { region: e.target.value } })}
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
              onChange={(e) => dispatch({ type: 'edit', patch: { endpoint: e.target.value } })}
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
            onChange={(e) => dispatch({ type: 'edit', patch: { apiKey: e.target.value } })}
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
              onChange={(e) => dispatch({ type: 'edit', patch: { defaultVoice: e.target.value } })}
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
              onChange={(e) => dispatch({ type: 'edit', patch: { defaultLocale: e.target.value } })}
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
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => dispatch({ type: 'edit', patch: { enabled: e.target.checked } })}
          />
          Enabled
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <SaveRow busy={busy} notice={notice} error={error} />
          {config?.configured ? (
            <button
              type="button"
              onClick={() => void test()}
              disabled={!canTest(form, config ?? null)}
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
