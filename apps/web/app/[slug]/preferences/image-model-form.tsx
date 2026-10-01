'use client';

/**
 * Which image generation model this person's chats draw with. Only shown
 * when the org has at least one (the page leaves it out otherwise) — with
 * exactly one there is nothing to choose between, but the person still
 * sees which model their pictures come from. "Organization default" is no
 * preference: the chat takes the org's first image model by name. A model
 * the admin has since disabled quietly falls back to that too, so a stale
 * pick never blocks a picture.
 */

import { useState } from 'react';
import type { ImagePrefs } from '@renkei/user-prefs/prefs';

export interface ImageModelOption {
  id: string;
  label: string;
  model: string;
}

export default function ImageModelForm({
  tenantId,
  initial,
  models,
}: {
  tenantId: string;
  initial: ImagePrefs;
  models: ImageModelOption[];
}) {
  // A saved id the org no longer offers reads as no preference, as the chat treats it.
  const known = (id: string | null) => (id && models.some((m) => m.id === id) ? id : null);
  const [modelId, setModelId] = useState<string | null>(known(initial.modelId));
  const [saved, setSaved] = useState<string | null>(known(initial.modelId));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  async function save() {
    setStatus('saving');
    try {
      const response = await fetch(`/api/tenant/${tenantId}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: { modelId } }),
      });
      if (response.ok) {
        setSaved(modelId);
        setStatus('saved');
      } else {
        setStatus('failed');
      }
    } catch {
      setStatus('failed');
    }
  }

  const first = models[0];
  return (
    <section
      aria-labelledby="image-model-heading"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <h3 id="image-model-heading" className="font-semibold">
        Image generation
      </h3>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        The model that draws pictures when you ask a chat for one.
      </p>

      <label className="mt-3 block text-sm" htmlFor="image-model-select">
        Preferred image model
      </label>
      <select
        id="image-model-select"
        value={modelId ?? ''}
        onChange={(event) => {
          setModelId(event.target.value || null);
          setStatus('idle');
        }}
        className="mt-1 w-full max-w-md rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      >
        <option value="">Organization default{first ? ` (${first.label})` : ''}</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label} · {model.model}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {models.length > 1
          ? 'Your chats use this model for every picture. If an administrator turns it off, they fall back to the organization default.'
          : 'Your organization has one image model, so every picture comes from it.'}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === 'saving' || modelId === saved}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {status === 'saved' ? <span className="text-sm text-green-700">Saved.</span> : null}
        {status === 'failed' ? (
          <span className="text-sm text-red-600 dark:text-red-400">Could not save.</span>
        ) : null}
      </div>
    </section>
  );
}
