'use client';

import { FormEvent, useReducer, useState } from 'react';
import {
  SALESFORCE_ADMIN_KIND,
  SALESFORCE_CRM_KIND,
  type SalesforceKind,
} from '@/lib/salesforce-kinds';
import ScopePicker from '@/components/scope-picker';
import {
  addButtonLabel,
  capabilityLabels,
  changeRequestsLine,
  editorReducer,
  editorSections,
  editorTitle,
  emptyListHint,
  initEditor,
  isAdminKind as isAdmin,
  keptAway,
  removeUrl,
  saveBody,
  secretField,
  type FlagField,
  type SalesforceConfig,
  type SalesforceConnectorRow,
  type TextField,
} from './salesforce-form.model';
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
import { reportFetchFailure } from '@/lib/fetch-json';

/**
 * The Salesforce connectors — one per Salesforce org the organization works
 * in (production, each sandbox), all of the same type and each
 * self-contained: its own External Client App, My Domain, switch and
 * ceiling. The capability boxes are Renkei's own ceiling
 * (salesforce-scopes.ts): Salesforce's OAuth scopes cannot tell a read from
 * a delete, so the narrowing is ours, and each person's Salesforce
 * permissions still decide every call.
 *
 * One form for both types (lib/salesforce-kinds.ts). The CRM's connectors
 * also say what they keep away from the model; the admin's say whether a
 * production org takes change requests.
 */
export function SalesforceForm({ origin }: { origin: string | null }) {
  return <SalesforceConnectorsForm origin={origin} kind={SALESFORCE_CRM_KIND} />;
}

/** The Salesforce admin connectors: the same list, on their own config row and apps. */
export function SalesforceAdminForm({ origin }: { origin: string | null }) {
  return <SalesforceConnectorsForm origin={origin} kind={SALESFORCE_ADMIN_KIND} />;
}

function SalesforceConnectorsForm({
  origin,
  kind,
}: {
  origin: string | null;
  kind: SalesforceKind;
}) {
  const [state, reload] = useConnectorConfig<SalesforceConfig>(kind.adminApi);
  const [editing, setEditing] = useState<string | null>(null);

  if (state.loading)
    return (
      <Card title={kind.label} status={null}>
        <LoadingRegion label="Loading settings…">
          <SkeletonForm fields={3} />
        </LoadingRegion>
      </Card>
    );
  if (state.error) {
    return (
      <Card title={kind.label} status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const connectors = state.data?.connectors ?? [];

  return (
    <div className="space-y-4">
      <Card title={kind.label} status={null}>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Add a {kind.label} connector for <strong>each Salesforce org</strong> people{' '}
          {isAdmin(kind) ? 'build in' : 'work in'} — your production org, and each sandbox. Each is
          its own connector: in that org, create an <strong>External Client App</strong> (Setup →
          External Client App Manager) with the callback URL <CallbackUrl origin={origin} />, the
          scopes <code className="font-mono text-xs">api</code>,{' '}
          <code className="font-mono text-xs">refresh_token</code> and{' '}
          <code className="font-mono text-xs">id</code>, and <strong>Require PKCE</strong>, then add
          its consumer key and secret here. People connect each org separately, and Salesforce
          applies each person&apos;s own access in that org on every call.
          {isAdmin(kind) && (
            <>
              {' '}
              Use an External Client App of its own, not the CRM connector&apos;s: building is
              connected and revoked separately from working records. Every change is a change
              request, checked by Salesforce and applied by the person in Renkei.
            </>
          )}
        </p>
        {connectors.length === 0 && (
          <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
            No {kind.label} connectors yet. {emptyListHint(kind)}
          </p>
        )}
      </Card>

      {connectors.map((connector) =>
        editing === connector.key ? (
          <ConnectorEditor
            key={connector.key}
            kind={kind}
            existing={connector}
            onDone={() => {
              setEditing(null);
              reload();
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <ConnectorSummary
            key={connector.key}
            kind={kind}
            connector={connector}
            onEdit={() => setEditing(connector.key)}
          />
        )
      )}

      {editing === '__new__' ? (
        <ConnectorEditor
          kind={kind}
          existing={null}
          isFirst={connectors.length === 0}
          onDone={() => {
            setEditing(null);
            reload();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing('__new__')}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          {addButtonLabel(kind, connectors.length)}
        </button>
      )}
    </div>
  );
}

function ConnectorSummary({
  kind,
  connector,
  onEdit,
}: {
  kind: SalesforceKind;
  connector: SalesforceConnectorRow;
  onEdit: () => void;
}) {
  const capabilities = capabilityLabels(kind, connector.scopes);
  return (
    <Card
      title={`${kind.label} · ${connector.name}`}
      status={<StatusPill configured={connector.hasClientSecret} enabled={connector.enabled} />}
    >
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-gray-500 dark:text-gray-400">My Domain</dt>
        <dd className="break-words font-mono text-xs">{connector.myDomain}</dd>
        <dt className="text-gray-500 dark:text-gray-400">Kind</dt>
        <dd>{connector.sandbox ? 'Sandbox' : 'Production'}</dd>
        <dt className="text-gray-500 dark:text-gray-400">Consumer key</dt>
        <dd className="break-all font-mono text-xs">{connector.clientId}</dd>
        <dt className="text-gray-500 dark:text-gray-400">People may let Renkei</dt>
        <dd>{capabilities.join(', ') || 'nothing'}</dd>
        {isAdmin(kind) ? (
          <>
            <dt className="text-gray-500 dark:text-gray-400">Change requests</dt>
            <dd>{changeRequestsLine(connector)}</dd>
          </>
        ) : (
          <>
            <dt className="text-gray-500 dark:text-gray-400">Kept from the assistant</dt>
            <dd className="break-words">{keptAway(connector)}</dd>
          </>
        )}
      </dl>
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${connector.name}`}
        className="mt-3 rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
      >
        Edit
      </button>
    </Card>
  );
}

function ConnectorEditor({
  kind,
  existing,
  isFirst = false,
  onDone,
  onCancel,
}: {
  kind: SalesforceKind;
  existing: SalesforceConnectorRow | null;
  isFirst?: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [state, dispatch] = useReducer(editorReducer, { kind, existing, isFirst }, initEditor);
  const setText = (field: TextField) => (value: string) => dispatch({ type: 'text', field, value });
  const setFlag = (field: FlagField) => (value: boolean) =>
    dispatch({ type: 'flag', field, value });
  const sections = editorSections(kind, state);
  const secret = secretField(existing);

  async function save(e: FormEvent) {
    e.preventDefault();
    dispatch({ type: 'sent' });
    const failure = await putJson(kind.adminApi, saveBody(kind, existing, state));
    if (failure) {
      dispatch({ type: 'failed', error: failure });
      return;
    }
    dispatch({ type: 'saved' });
    onDone();
  }

  async function remove() {
    if (!existing) return;
    dispatch({ type: 'sent' });
    const response = await fetch(removeUrl(kind, existing.key), {
      method: 'DELETE',
    }).catch((error: unknown) => {
      reportFetchFailure('DELETE', kind.adminApi, 0, 'Could not reach the server', error);
      return null;
    });
    if (!response?.ok) {
      if (response)
        reportFetchFailure('DELETE', kind.adminApi, response.status, 'Could not remove it');
      dispatch({ type: 'failed', error: 'Could not remove it' });
      return;
    }
    onDone();
  }

  const idBase = `${kind.key}-${existing?.key ?? 'new'}`;
  return (
    <Card
      title={editorTitle(kind, existing)}
      status={
        existing ? (
          <StatusPill configured={existing.hasClientSecret} enabled={existing.enabled} />
        ) : null
      }
    >
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor={`${idBase}-name`} className={labelClass}>
            Name
          </label>
          <input
            id={`${idBase}-name`}
            required
            value={state.name}
            onChange={(e) => setText('name')(e.target.value)}
            placeholder="Production, UAT, Full Copy…"
            className={inputClass}
          />
          <p className={hintClass}>What people and the tools call this org.</p>
        </div>
        <div>
          <label htmlFor={`${idBase}-domain`} className={labelClass}>
            My Domain
          </label>
          <input
            id={`${idBase}-domain`}
            required
            value={state.myDomain}
            onChange={(e) => setText('myDomain')(e.target.value)}
            placeholder="acme.my.salesforce.com"
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            This org&apos;s My Domain (Setup → My Domain) — a sandbox&apos;s looks like{' '}
            <code className="font-mono text-xs">acme--uat.sandbox.my.salesforce.com</code>. Not{' '}
            <code className="font-mono text-xs">login.salesforce.com</code> or{' '}
            <code className="font-mono text-xs">test.salesforce.com</code>. Sign-in, tokens and
            every API call for this connector go to this address alone.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.sandbox}
            onChange={(e) => setFlag('sandbox')(e.target.checked)}
          />
          This is a sandbox
        </label>
        <div>
          <label htmlFor={`${idBase}-client-id`} className={labelClass}>
            Consumer key
          </label>
          <input
            id={`${idBase}-client-id`}
            required
            value={state.clientId}
            onChange={(e) => setText('clientId')(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor={`${idBase}-client-secret`} className={labelClass}>
            Consumer secret
          </label>
          <input
            id={`${idBase}-client-secret`}
            type="password"
            required={secret.required}
            value={state.clientSecret}
            onChange={(e) => setText('clientSecret')(e.target.value)}
            placeholder={secret.placeholder}
            className={`${inputClass} font-mono`}
          />
        </div>
        <fieldset>
          <legend className={labelClass}>What people may let Renkei do in this org</legend>
          <ScopePicker
            groups={kind.scopeGroups}
            options={kind.scopeOptions}
            checked={state.checkedIds}
            onToggle={(optionId, on) => dispatch({ type: 'toggleOption', optionId, on })}
          />
          <p className={hintClass}>
            This is the ceiling: people can narrow it when they connect, never widen it. Salesforce
            grants the whole API to a connection, so these boxes are Renkei&apos;s own limit on
            which tools it offers — each person&apos;s Salesforce permissions still decide what any
            tool may do.{' '}
            {isAdmin(kind)
              ? 'The org’s setup — objects, fields, formulas, validation rules — is sent to your organization’s configured model provider; no records are read.'
              : 'Record contents are sent to your organization’s configured model provider; decide that before turning this on for sensitive records.'}
          </p>
        </fieldset>
        {isAdmin(kind) ? (
          sections.productionChanges && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={state.productionChanges}
                onChange={(e) => setFlag('productionChanges')(e.target.checked)}
              />
              <span>
                Allow change requests in this production org. Off, it is read only here: people
                build in a sandbox and promote. On, each change is still validated by Salesforce and
                applied only when the person approves it in Renkei.
              </span>
            </label>
          )
        ) : (
          <fieldset className="space-y-3">
            <legend className={labelClass}>Kept away from the assistant</legend>
            <p className={hintClass}>
              Objects and fields no Salesforce tool reads, queries, searches, reports on or writes
              in this org — even for people who can see them in Salesforce. Use it for what should
              not reach your model provider: case notes, health or payroll objects. It only takes
              things away.
            </p>
            <div>
              <label htmlFor={`${idBase}-excluded-objects`} className={labelClass}>
                Hidden objects
              </label>
              <textarea
                id={`${idBase}-excluded-objects`}
                rows={2}
                value={state.excludedObjects}
                onChange={(e) => setText('excludedObjects')(e.target.value)}
                placeholder="Case_Note__c"
                className={`${inputClass} font-mono`}
              />
              <p className={hintClass}>API names, one per line.</p>
            </div>
            <div>
              <label htmlFor={`${idBase}-excluded-fields`} className={labelClass}>
                Hidden fields
              </label>
              <textarea
                id={`${idBase}-excluded-fields`}
                rows={2}
                value={state.excludedFields}
                onChange={(e) => setText('excludedFields')(e.target.value)}
                placeholder="Contact.Diagnosis__c"
                className={`${inputClass} font-mono`}
              />
              <p className={hintClass}>Object.Field API names, one per line.</p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={state.hideRestricted}
                onChange={(e) => setFlag('hideRestricted')(e.target.checked)}
              />
              <span>
                Hide every field this org&apos;s data classification marks Restricted or Mission
                Critical (Setup → Data Classification). If Salesforce cannot say how a field is
                classified, the object is not shown at all.
              </span>
            </label>
          </fieldset>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(e) => setFlag('enabled')(e.target.checked)}
          />
          Enabled
        </label>
        <SaveRow busy={state.busy} notice={state.notice} error={state.error} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onCancel} className="text-sm underline">
            Cancel
          </button>
          {existing &&
            (state.confirmingRemove ? (
              <span className="flex flex-wrap items-center gap-2 text-sm">
                Remove {existing.name}? Everyone&apos;s connection to this org stops working.
                <button
                  type="button"
                  onClick={() => void remove()}
                  className="rounded-md bg-red-600 px-2 py-1 text-white"
                >
                  Yes, remove
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'disarmRemove' })}
                  className="underline"
                >
                  Keep it
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => dispatch({ type: 'armRemove' })}
                className="text-sm text-red-700 underline dark:text-red-300"
              >
                Remove this connector
              </button>
            ))}
        </div>
      </form>
    </Card>
  );
}
