'use client';

import { useState } from 'react';
import { sendJsonFull } from '@/lib/fetch-json';

export interface EditableSettings {
  readOnly: boolean;
  enableDcr: boolean;
  maxJqlResults: number;
  maxAttachmentBytes: number;
  rateLimitPerUserPerMinute: number;
  accessTokenTtlMinutes: number;
  authorizationCodeTtlSeconds: number;
  refreshTokenTtlDays: number;
  agentMaxChainDepth: number;
  agentRunTimeoutMinutes: number;
  agentMaxStepAttempts: number;
  agentMaxRunsPerDay: number;
  contentPollMinutes: number;
  logRetentionDays: number;
}

const inputClass =
  'w-28 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm tabular-nums dark:border-gray-700 dark:bg-gray-900';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div className="min-w-0 max-w-md">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        on ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700'
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
          on ? 'left-[1.375rem]' : 'left-0.5'
        }`}
      />
    </button>
  );
}

/**
 * The settings that have no more specific home, grouped by what they
 * protect. One Save for the whole page: these are numbers an operator
 * adjusts a few at a time, and eleven separate save buttons would be
 * eleven chances to forget one.
 */
export function SettingsForm({ slug, initial }: { slug: string; initial: EditableSettings }) {
  const [values, setValues] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  function set<K extends keyof EditableSettings>(key: K, value: EditableSettings[K]) {
    setValues((previous) => ({ ...previous, [key]: value }));
    setState('idle');
  }

  function numberInput(
    key: {
      [K in keyof EditableSettings]: EditableSettings[K] extends number ? K : never;
    }[keyof EditableSettings],
    range: string
  ) {
    return (
      <span className="flex items-center gap-2">
        <input
          type="number"
          aria-label={key}
          value={values[key]}
          onChange={(event) => set(key, Number(event.target.value))}
          className={inputClass}
        />
        <span className="w-20 text-xs text-gray-400 dark:text-gray-600">{range}</span>
      </span>
    );
  }

  async function save() {
    setState('saving');
    setError(null);
    const result = await sendJsonFull<{ settings: EditableSettings }>(
      `/api/admin/${slug}/org-settings`,
      'PUT',
      values
    );
    if (result.error || !result.data) {
      setState('error');
      setError(result.error ?? 'Save failed');
      return;
    }
    // The server clamps; adopting its answer keeps the form honest about
    // what was actually stored.
    setValues(result.data.settings);
    setSaved(result.data.settings);
    setState('saved');
  }

  return (
    <div className="space-y-4">
      <Section title="Safety">
        <Row
          label="Read-only mode"
          hint="Hides every tool that changes an external system, org-wide and immediately. Read tools keep working. The brake to pull while investigating."
        >
          <Toggle
            on={values.readOnly}
            onChange={(next) => set('readOnly', next)}
            label="Read-only mode"
          />
        </Row>
      </Section>

      <Section title="Agents">
        <Row
          label="Max runs per day"
          hint="Org-wide ceiling on agent runs started per day — the runaway-trigger brake."
        >
          {numberInput('agentMaxRunsPerDay', '1–10,000')}
        </Row>
        <Row label="Run timeout (minutes)" hint="Wall-clock budget for a single agent run.">
          {numberInput('agentRunTimeoutMinutes', '1–120')}
        </Row>
        <Row
          label="Max tries per step"
          hint="Ceiling on a step's 'give up after N tries' (default 10). Enforced at run time, so lowering it applies to existing agents immediately."
        >
          {numberInput('agentMaxStepAttempts', '1–100')}
        </Row>
        <Row
          label="Max chain depth"
          hint="How many agents may trigger each other in a chain before the platform refuses."
        >
          {numberInput('agentMaxChainDepth', '1–10')}
        </Row>
      </Section>

      <Section title="Data & logs">
        <Row
          label="Content poll interval (minutes)"
          hint="How stale watched Jira projects, Confluence spaces and document libraries may get before they are polled again. Lower = fresher search results and more provider API calls."
        >
          {numberInput('contentPollMinutes', '5–1,440')}
        </Row>
        <Row
          label="Log retention (days)"
          hint="How long platform logs are kept before being purged. 0 keeps them forever. Deployment-wide: with several organizations, the longest retention wins."
        >
          {numberInput('logRetentionDays', '0–3,650')}
        </Row>
      </Section>

      <Section title="MCP clients & tokens">
        <Row
          label="Dynamic client registration"
          hint="Lets MCP clients (Claude, editors) register themselves on this org's OAuth server without an admin pre-creating each one."
        >
          <Toggle
            on={values.enableDcr}
            onChange={(next) => set('enableDcr', next)}
            label="Dynamic client registration"
          />
        </Row>
        <Row
          label="Access token lifetime (minutes)"
          hint="How long a client's access token lasts before it must refresh."
        >
          {numberInput('accessTokenTtlMinutes', '5–1,440')}
        </Row>
        <Row
          label="Refresh token lifetime (days)"
          hint="How long a signed-in client stays connected without re-authorizing."
        >
          {numberInput('refreshTokenTtlDays', '1–365')}
        </Row>
        <Row
          label="Authorization code lifetime (seconds)"
          hint="How long the one-time code in the OAuth redirect stays valid."
        >
          {numberInput('authorizationCodeTtlSeconds', '30–600')}
        </Row>
      </Section>

      <Section title="Request limits">
        <Row
          label="Tool calls per user per minute"
          hint="Rate limit on MCP tool calls, per person."
        >
          {numberInput('rateLimitPerUserPerMinute', '1–10,000')}
        </Row>
        <Row label="Max search results" hint="Cap on rows a Jira search (JQL) may return.">
          {numberInput('maxJqlResults', '1–1,000')}
        </Row>
        <Row
          label="Max attachment size (bytes)"
          hint="Largest attachment a tool will upload or download."
        >
          {numberInput('maxAttachmentBytes', '1MB–100MB')}
        </Row>
      </Section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={state === 'saving' || !dirty}
          onClick={() => void save()}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {state === 'saving' ? 'Saving…' : 'Save settings'}
        </button>
        {state === 'saved' && <span className="text-xs text-green-600">Saved.</span>}
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        {dirty && state !== 'saving' && (
          <span className="text-xs text-gray-500">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}
