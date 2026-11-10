'use client';

import { FormEvent, useEffect, useReducer } from 'react';
import {
  ENTRA_DEVELOPER_SCOPE_GROUPS,
  ENTRA_DEVELOPER_SCOPE_OPTIONS,
  ENTRA_DEVELOPER_REQUIRED_SCOPES,
} from '@/lib/entra-developer-scopes';
import ScopePicker from '@/components/scope-picker';
import ExternalLink from '@/components/external-link';
import {
  appRegistrationReducer,
  initialAppRegistration,
  saveBody,
  secretField,
  type AppRegistrationConfig,
  type AppRegistrationSpec,
} from './app-registration-form.model';
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

const SPEC: AppRegistrationSpec = {
  options: ENTRA_DEVELOPER_SCOPE_OPTIONS,
  alwaysScopes: ENTRA_DEVELOPER_REQUIRED_SCOPES,
  directory: true,
};
const reducer = appRegistrationReducer(SPEC);

/**
 * The Entra Developer app registration — the microsoft-form.tsx shape for
 * the SECOND Entra app: application provisioning permissions on a
 * registration of their own, so an org can hand them to its developers
 * without widening anyone's Microsoft 365 consent.
 */
export function EntraDeveloperForm({ origin }: { origin: string | null }) {
  const url = `/api/admin/connectors/entra-developer`;
  const [state, reload] = useConnectorConfig<AppRegistrationConfig>(url);
  const [form, dispatch] = useReducer(reducer, SPEC, initialAppRegistration);
  const { fields, busy, notice, error } = form;

  useEffect(() => {
    if (state.data) dispatch({ type: 'loaded', config: state.data });
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    dispatch({ type: 'saving' });
    const failure = await putJson(url, saveBody(SPEC, fields));
    if (failure) {
      dispatch({ type: 'save-failed', error: failure });
      return;
    }
    dispatch({ type: 'saved' });
    reload();
  }

  if (state.loading)
    return (
      <Card title="Entra Developer" status={null}>
        <LoadingRegion label="Loading settings…">
          <SkeletonForm fields={3} />
        </LoadingRegion>
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Entra Developer" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;
  const secret = secretField(Boolean(config?.hasClientSecret));

  return (
    <Card
      title="Entra Developer"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        A <strong>separate</strong>{' '}
        <ExternalLink
          href="https://entra.microsoft.com"
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          Entra app registration
        </ExternalLink>{' '}
        from the Microsoft 365 one, through which a developer lets Renkei provision applications as
        them: app registrations, enterprise applications, app roles, and which users and groups hold
        each role. Register a <strong>Web</strong> platform whose redirect URI is{' '}
        <CallbackUrl origin={origin} />, grant the app the delegated Microsoft Graph permissions
        matching the ceiling below, and have an Entra admin consent to them — they are
        directory-wide, which is why they live on an app of their own. Entra still applies its own
        rules on every call: who may create applications, and who owns an existing one.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="entra-dev-client-id" className={labelClass}>
            Client ID
          </label>
          <input
            id="entra-dev-client-id"
            required
            value={fields.clientId}
            onChange={(e) => dispatch({ type: 'edit', patch: { clientId: e.target.value } })}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="entra-dev-directory-id" className={labelClass}>
            Directory (tenant) ID
          </label>
          <input
            id="entra-dev-directory-id"
            required
            value={fields.directoryTenantId}
            onChange={(e) =>
              dispatch({ type: 'edit', patch: { directoryTenantId: e.target.value } })
            }
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            The Entra directory GUID from the app registration&apos;s Overview page — not{' '}
            <code className="font-mono text-xs">common</code>; Renkei authorizes against your
            directory alone.
          </p>
        </div>
        <div>
          <label htmlFor="entra-dev-client-secret" className={labelClass}>
            Client secret
          </label>
          <input
            id="entra-dev-client-secret"
            type="password"
            required={secret.required}
            value={fields.clientSecret}
            onChange={(e) => dispatch({ type: 'edit', patch: { clientSecret: e.target.value } })}
            placeholder={secret.placeholder}
            className={`${inputClass} font-mono`}
          />
          {secret.storedHint && (
            <p className={hintClass}>A secret is stored but never shown; leave blank to keep it.</p>
          )}
        </div>
        <fieldset>
          <legend className={labelClass}>What users may grant</legend>
          <ScopePicker
            groups={ENTRA_DEVELOPER_SCOPE_GROUPS}
            options={ENTRA_DEVELOPER_SCOPE_OPTIONS}
            checked={fields.checkedIds}
            onToggle={(optionId, on) => dispatch({ type: 'toggle', optionId, on })}
          />
          <p className={hintClass}>
            This is the ceiling: users can narrow it when they connect, never widen it. Every
            checked capability must also be added to the app registration as delegated Microsoft
            Graph permissions, with admin consent granted — Microsoft refuses the authorize step
            otherwise.{' '}
            <code className="font-mono text-xs">{ENTRA_DEVELOPER_REQUIRED_SCOPES.join(' ')}</code>{' '}
            are always included (identifying who granted, and keeping the grant refreshable). Users
            who already connected keep their old scopes until they reconnect.
          </p>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={fields.enabled}
            onChange={(e) => dispatch({ type: 'edit', patch: { enabled: e.target.checked } })}
          />
          Enabled
        </label>
        <SaveRow busy={busy} notice={notice} error={error} />
      </form>
    </Card>
  );
}
