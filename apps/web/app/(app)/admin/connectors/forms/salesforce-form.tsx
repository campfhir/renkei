'use client';

import { FormEvent, useEffect, useState } from 'react';
import { SALESFORCE_SCOPE_GROUPS, SALESFORCE_SCOPE_OPTIONS } from '@/lib/salesforce-scopes';
import ScopePicker from '@/components/scope-picker';
import { optionWithin, scopesOfOptions } from '@/lib/scope-catalog';
import {
  useConnectorConfig,
  putJson,
  Card,
  StatusPill,
  CallbackUrl,
  inputClass,
  labelClass,
  hintClass,
  SaveRow,
} from './shared';
import { LoadingRegion, SkeletonForm } from '@/components/skeleton';

/* ----------------------------------------------------------------------- */

interface SalesforceConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  myDomain: string | null;
  scopes: string | null;
  hasClientSecret: boolean;
}

/**
 * The Salesforce CRM app — an External Client App the organization creates
 * in its own Salesforce org. The capability boxes are Renkei's own ceiling
 * (salesforce-scopes.ts): Salesforce's OAuth scopes cannot tell a read from
 * a delete, so the narrowing is ours, and the person's own Salesforce
 * permissions still decide every call.
 */
export function SalesforceForm({ origin }: { origin: string | null }) {
  const url = `/api/admin/connectors/salesforce`;
  const [state, reload] = useConnectorConfig<SalesforceConfig>(url);
  const [clientId, setClientId] = useState('');
  const [myDomain, setMyDomain] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () =>
      new Set(SALESFORCE_SCOPE_OPTIONS.filter((option) => option.defaultChecked).map((o) => o.id))
  );
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setClientId(state.data.clientId ?? '');
    setMyDomain(state.data.myDomain ?? '');
    if (state.data.configured && state.data.scopes) {
      const stored = new Set(state.data.scopes.split(/\s+/));
      const matching = SALESFORCE_SCOPE_OPTIONS.filter((option) => optionWithin(option, stored));
      if (matching.length > 0) setCheckedIds(new Set(matching.map((option) => option.id)));
    }
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  function toggleOption(optionId: string, on: boolean) {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (on) next.add(optionId);
      else next.delete(optionId);
      return next;
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      clientId: clientId.trim(),
      myDomain: myDomain.trim(),
      // Blank means keep the stored secret — omit it from the payload.
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      enabled,
      scopes: scopesOfOptions(SALESFORCE_SCOPE_OPTIONS, checkedIds).join(' '),
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setClientSecret('');
    setNotice('Saved');
    reload();
  }

  if (state.loading)
    return (
      <Card title="Salesforce" status={null}>
        <LoadingRegion label="Loading settings…">
          <SkeletonForm fields={3} />
        </LoadingRegion>
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Salesforce" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title="Salesforce"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        An <strong>External Client App</strong> you create in your own Salesforce org (Setup →
        External Client App Manager), through which each person lets Renkei work in Salesforce as
        them. Enable OAuth with the callback URL <CallbackUrl origin={origin} />, the scopes{' '}
        <code className="font-mono text-xs">api</code>,{' '}
        <code className="font-mono text-xs">refresh_token</code> and{' '}
        <code className="font-mono text-xs">id</code>, and <strong>Require PKCE</strong>; then paste
        its consumer key and secret here. Salesforce applies each person&apos;s own access — object
        and field permissions, sharing, validation rules — on every call.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="salesforce-my-domain" className={labelClass}>
            My Domain
          </label>
          <input
            id="salesforce-my-domain"
            required
            value={myDomain}
            onChange={(e) => setMyDomain(e.target.value)}
            placeholder="acme.my.salesforce.com"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            Your org&apos;s My Domain (Setup → My Domain), not{' '}
            <code className="font-mono text-xs">login.salesforce.com</code>. Sign-in, tokens and
            every API call go to this address alone, and a connection from any other org is refused.
          </p>
        </div>
        <div>
          <label htmlFor="salesforce-client-id" className={labelClass}>
            Consumer key
          </label>
          <input
            id="salesforce-client-id"
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="salesforce-client-secret" className={labelClass}>
            Consumer secret
          </label>
          <input
            id="salesforce-client-secret"
            type="password"
            required={!config?.hasClientSecret}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={config?.hasClientSecret ? 'Stored — leave blank to keep' : ''}
            className={`${inputClass} font-mono`}
          />
          {config?.hasClientSecret && (
            <p className={hintClass}>A secret is stored but never shown; leave blank to keep it.</p>
          )}
        </div>
        <fieldset>
          <legend className={labelClass}>What people may let Renkei do</legend>
          <ScopePicker
            groups={SALESFORCE_SCOPE_GROUPS}
            options={SALESFORCE_SCOPE_OPTIONS}
            checked={checkedIds}
            onToggle={toggleOption}
          />
          <p className={hintClass}>
            This is the ceiling: people can narrow it when they connect, never widen it. Salesforce
            itself grants the whole API to a connection, so these boxes are Renkei&apos;s own limit
            on which tools it offers — and each person&apos;s Salesforce permissions still decide
            what any tool may do. Record contents are sent to your organization&apos;s configured
            model provider; decide that before turning this on for sensitive records.
          </p>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <SaveRow busy={busy} notice={notice} error={error} />
      </form>
    </Card>
  );
}
