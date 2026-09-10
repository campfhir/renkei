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

/* ----------------------------------------------------------------------- */

interface WebSearchConfig {
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  apiVersion: string | null;
  reasoningEffort: string | null;
  userLocation: { country?: string; city?: string; region?: string; timezone?: string } | null;
  allowedDomains: string[];
  blockedDomains: string[];
  hasApiKey: boolean;
}

/**
 * The web-search connector: the Azure OpenAI (or OpenAI) Responses API
 * deployment whose built-in `web_search` tool answers the `web_search`
 * MCP tool. Org-wide like Embeddings and Mistral OCR — one endpoint, one
 * deployment, one key — plus the org policy that shapes every search: an
 * approximate location and domain allow/block lists.
 */
export function WebSearchForm({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/web-search`;
  const [state, reload] = useConnectorConfig<WebSearchConfig>(url);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiVersion, setApiVersion] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [timezone, setTimezone] = useState('');
  const [allowedDomains, setAllowedDomains] = useState('');
  const [blockedDomains, setBlockedDomains] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setBaseUrl(state.data.baseUrl ?? '');
    setModel(state.data.model ?? '');
    setApiVersion(state.data.apiVersion ?? '');
    setReasoningEffort(state.data.reasoningEffort ?? '');
    setCountry(state.data.userLocation?.country ?? '');
    setCity(state.data.userLocation?.city ?? '');
    setRegion(state.data.userLocation?.region ?? '');
    setTimezone(state.data.userLocation?.timezone ?? '');
    setAllowedDomains((state.data.allowedDomains ?? []).join('\n'));
    setBlockedDomains((state.data.blockedDomains ?? []).join('\n'));
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      // Blank means keep the stored key — omit it from the payload.
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      apiVersion: apiVersion.trim(),
      reasoningEffort,
      userLocation: {
        country: country.trim(),
        city: city.trim(),
        region: region.trim(),
        timezone: timezone.trim(),
      },
      allowedDomains: allowedDomains.split(/[\s,]+/).filter(Boolean),
      blockedDomains: blockedDomains.split(/[\s,]+/).filter(Boolean),
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

  if (state.loading)
    return (
      <Card title="Web search" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Web search" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="Web search"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Public-web search for models and agents, through an Azure OpenAI deployment&apos;s built-in{' '}
        <code className="font-mono text-xs">web_search</code> tool (Grounding with Bing) on the
        Responses API. One org-wide key; every <code className="font-mono text-xs">web_search</code>{' '}
        call is billed as a Bing search, and the query text leaves the Azure compliance boundary.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="ws-base" className={labelClass}>
            Base URL
          </label>
          <input
            id="ws-base"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://{resource}.openai.azure.com/openai/v1"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            The resource&apos;s OpenAI-compatible v1 surface; Renkei appends{' '}
            <code className="font-mono text-xs">/responses</code>. OpenAI itself is{' '}
            <code className="font-mono text-xs">https://api.openai.com/v1</code>.
          </p>
        </div>
        <div>
          <label htmlFor="ws-model" className={labelClass}>
            Deployment (model)
          </label>
          <input
            id="ws-model"
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-5.5"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            Your deployment name on Azure AI Foundry — a GPT-4-or-later model that supports web
            search; a reasoning model (GPT-5 family) gives agentic multi-step search.
          </p>
        </div>
        <div>
          <label htmlFor="ws-key" className={labelClass}>
            API key
          </label>
          <input
            id="ws-key"
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
            <label htmlFor="ws-effort" className={labelClass}>
              Reasoning effort <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <select
              id="ws-effort"
              className={inputClass}
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value)}
            >
              <option value="">Model default</option>
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
            </select>
            <p className={hintClass}>
              Reasoning models only. Higher means deeper, slower searches; low keeps a lookup quick.
            </p>
          </div>
          <div>
            <label htmlFor="ws-api-version" className={labelClass}>
              API version <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <input
              id="ws-api-version"
              value={apiVersion}
              onChange={(e) => setApiVersion(e.target.value)}
              placeholder="blank for the /openai/v1 surface"
              className={`${inputClass} font-mono`}
            />
            <p className={hintClass}>
              Appended as <code className="font-mono text-xs">?api-version=…</code> only when the
              surface demands it.
            </p>
          </div>
        </div>
        <fieldset>
          <legend className={labelClass}>
            Default location <span className="font-normal text-gray-500">(optional)</span>
          </legend>
          <div className="grid gap-3 sm:grid-cols-4">
            <input
              aria-label="Country code"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="US"
              maxLength={2}
              className={`${inputClass} font-mono`}
            />
            <input
              aria-label="City"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Chicago"
              className={inputClass}
            />
            <input
              aria-label="Region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="Illinois"
              className={inputClass}
            />
            <input
              aria-label="Time zone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/Chicago"
              className={`${inputClass} font-mono`}
            />
          </div>
          <p className={hintClass}>
            Results are tuned to this approximate location (two-letter country code, city, region,
            IANA time zone) unless a call passes its own. Leave blank for no preference.
          </p>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="ws-allowed" className={labelClass}>
              Allowed domains <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <textarea
              id="ws-allowed"
              rows={4}
              value={allowedDomains}
              onChange={(e) => setAllowedDomains(e.target.value)}
              placeholder={'learn.microsoft.com\nwww.who.int'}
              className={`${inputClass} font-mono`}
            />
            <p className={hintClass}>
              One per line, up to 100. When set, results come only from these sites (subdomains
              included) and callers can narrow further but never beyond them.
            </p>
          </div>
          <div>
            <label htmlFor="ws-blocked" className={labelClass}>
              Blocked domains <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <textarea
              id="ws-blocked"
              rows={4}
              value={blockedDomains}
              onChange={(e) => setBlockedDomains(e.target.value)}
              placeholder={'en.wikipedia.org\nwww.reddit.com'}
              className={`${inputClass} font-mono`}
            />
            <p className={hintClass}>One per line. Never surfaced as a source.</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <SaveRow busy={busy} notice={notice} error={error} />
      </form>
    </Card>
  );
}
