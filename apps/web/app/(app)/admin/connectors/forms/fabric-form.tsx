'use client';

import { FormEvent, useEffect, useReducer } from 'react';
import {
  FABRIC_SCOPE_GROUPS,
  FABRIC_SCOPE_OPTIONS,
  FABRIC_REQUIRED_SCOPES,
} from '@/lib/fabric-scopes';
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
  options: FABRIC_SCOPE_OPTIONS,
  alwaysScopes: FABRIC_REQUIRED_SCOPES,
  directory: true,
};
const reducer = appRegistrationReducer(SPEC);

/**
 * The Microsoft Fabric app registration — the entra-developer-form.tsx
 * shape for a THIRD Entra app: delegated Fabric permissions, which Entra
 * mints on a token of their own (Fabric is a separate resource from Graph).
 */
export function FabricForm({ origin }: { origin: string | null }) {
  const url = `/api/admin/connectors/fabric`;
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
      <Card title="Microsoft Fabric" status={null}>
        <LoadingRegion label="Loading settings…">
          <SkeletonForm fields={3} />
        </LoadingRegion>
      </Card>
    );
  if (state.error) {
    return (
      <Card title="Microsoft Fabric" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;
  const secret = secretField(Boolean(config?.hasClientSecret));

  return (
    <Card
      title="Microsoft Fabric"
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
        through which a person lets Renkei work in Microsoft Fabric as them: browse workspaces,
        lakehouses and their tables, read notebook and data pipeline definitions, and create or
        change workspaces, notebooks and pipelines. Register a <strong>Web</strong> platform whose
        redirect URI is <CallbackUrl origin={origin} />, and add the delegated permissions matching
        the ceiling below from <strong>Power BI Service</strong> (where Fabric&apos;s permissions
        are listed). It cannot be the Microsoft 365 registration&apos;s grant: Entra mints a token
        for one API at a time. Fabric still applies each person&apos;s workspace role on every call,
        and the Fabric admin portal must allow users to call Fabric&apos;s APIs.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="fabric-client-id" className={labelClass}>
            Client ID
          </label>
          <input
            id="fabric-client-id"
            required
            value={fields.clientId}
            onChange={(e) => dispatch({ type: 'edit', patch: { clientId: e.target.value } })}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor="fabric-directory-id" className={labelClass}>
            Directory (tenant) ID
          </label>
          <input
            id="fabric-directory-id"
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
          <label htmlFor="fabric-client-secret" className={labelClass}>
            Client secret
          </label>
          <input
            id="fabric-client-secret"
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
            groups={FABRIC_SCOPE_GROUPS}
            options={FABRIC_SCOPE_OPTIONS}
            checked={fields.checkedIds}
            onToggle={(optionId, on) => dispatch({ type: 'toggle', optionId, on })}
          />
          <p className={hintClass}>
            This is the ceiling: users can narrow it when they connect, never widen it. Every
            checked capability must also be added to the app registration as a delegated Fabric
            (Power BI Service) permission, with consent granted where your tenant requires it —
            Microsoft refuses the authorize step otherwise.{' '}
            <code className="font-mono text-xs">{FABRIC_REQUIRED_SCOPES.join(' ')}</code> are always
            included (identifying who granted, and keeping the grant refreshable). Users who already
            connected keep their old scopes until they reconnect.
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
