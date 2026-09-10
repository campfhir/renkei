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

interface MistralOcrConfig {
  configured: boolean;
  enabled: boolean;
  endpoint: string | null;
  model: string | null;
  hasApiKey: boolean;
}

export function MistralOcrForm({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/mistral-ocr`;
  const [state, reload] = useConnectorConfig<MistralOcrConfig>(url);
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setEndpoint(state.data.endpoint ?? '');
    setModel(state.data.model ?? '');
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      endpoint: endpoint.trim(),
      model: model.trim(),
      // Blank means keep the stored key — omit it from the payload.
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
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
      <Card title="Mistral OCR" status={null}>
        Loading…
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Mistral OCR" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="Mistral OCR"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Mistral Document AI (OCR 4) as deployed on your org&apos;s Microsoft Foundry — used by batch
        document pipelines and the ad-hoc OCR tool. One org-wide key, no per-user sign-in.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="mo-endpoint" className={labelClass}>
            Foundry endpoint URL
          </label>
          <input
            id="mo-endpoint"
            required
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://your-resource.services.ai.azure.com/models"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="mo-model" className={labelClass}>
            Model / deployment name
          </label>
          <input
            id="mo-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="mistral-ocr-4-0 (default if left blank)"
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="mo-key" className={labelClass}>
            API key
          </label>
          <input
            id="mo-key"
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
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <SaveRow busy={busy} notice={notice} error={error} />
      </form>
    </Card>
  );
}
