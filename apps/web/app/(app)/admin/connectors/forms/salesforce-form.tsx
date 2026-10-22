'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  SALESFORCE_ADMIN_KIND,
  SALESFORCE_CRM_KIND,
  type SalesforceKind,
} from '@/lib/salesforce-kinds';
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

interface SalesforceConnectorRow {
  key: string;
  name: string;
  myDomain: string;
  sandbox: boolean;
  enabled: boolean;
  clientId: string;
  scopes: string;
  excludedObjects: string[];
  excludedFields: string[];
  hideRestricted: boolean;
  productionChanges: boolean;
  hasClientSecret: boolean;
}

interface SalesforceConfig {
  configured: boolean;
  enabled: boolean;
  connectors: SalesforceConnectorRow[];
}

function defaultChecked(kind: SalesforceKind): Set<string> {
  return new Set(kind.scopeOptions.filter((option) => option.defaultChecked).map((o) => o.id));
}

const isAdmin = (kind: SalesforceKind) => kind.key === SALESFORCE_ADMIN_KIND.key;

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
            No {kind.label} connectors yet.{' '}
            {isAdmin(kind)
              ? 'Start with a sandbox to build in.'
              : 'Start with your production org.'}
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
          {connectors.length === 0
            ? isAdmin(kind)
              ? 'Add your first org'
              : 'Add your production org'
            : 'Add a Salesforce org'}
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
  const capabilities = kind.scopeOptions
    .filter((option) => optionWithin(option, new Set(connector.scopes.split(/\s+/))))
    .map((option) => option.label);
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
            <dd>
              {connector.sandbox
                ? 'Applied here when the person approves them'
                : connector.productionChanges
                  ? 'Allowed in this production org'
                  : 'Not in this production org — read only'}
            </dd>
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

/** The connector's hidden objects and fields, in one line. */
function keptAway(connector: SalesforceConnectorRow): string {
  const parts = [
    ...connector.excludedObjects.map((name) => `${name} (object)`),
    ...connector.excludedFields,
    ...(connector.hideRestricted ? ['fields classified Restricted or Mission Critical'] : []),
  ];
  return parts.join(', ') || 'nothing';
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
  // A CRM usually starts with production; building usually starts in a sandbox.
  const firstIsProduction = isFirst && !isAdmin(kind);
  const [name, setName] = useState(existing?.name ?? (firstIsProduction ? 'Production' : ''));
  const [myDomain, setMyDomain] = useState(existing?.myDomain ?? '');
  const [sandbox, setSandbox] = useState(existing?.sandbox ?? !firstIsProduction);
  const [clientId, setClientId] = useState(existing?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [excludedObjects, setExcludedObjects] = useState(
    (existing?.excludedObjects ?? []).join('\n')
  );
  const [excludedFields, setExcludedFields] = useState((existing?.excludedFields ?? []).join('\n'));
  const [hideRestricted, setHideRestricted] = useState(existing?.hideRestricted ?? false);
  const [productionChanges, setProductionChanges] = useState(existing?.productionChanges ?? false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => defaultChecked(kind));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    if (!existing?.scopes) return;
    const stored = new Set(existing.scopes.split(/\s+/));
    const matching = kind.scopeOptions.filter((option) => optionWithin(option, stored));
    if (matching.length > 0) setCheckedIds(new Set(matching.map((option) => option.id)));
  }, [existing?.scopes, kind]);

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
    const failure = await putJson(kind.adminApi, {
      ...(existing ? { key: existing.key } : {}),
      name: name.trim(),
      myDomain: myDomain.trim(),
      sandbox,
      clientId: clientId.trim(),
      // Blank means keep the stored secret — omit it from the payload.
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      enabled,
      scopes: scopesOfOptions(kind.scopeOptions, checkedIds).join(' '),
      ...(isAdmin(kind)
        ? { productionChanges: !sandbox && productionChanges }
        : { excludedObjects, excludedFields, hideRestricted }),
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setClientSecret('');
    setNotice('Saved');
    onDone();
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    const response = await fetch(`${kind.adminApi}?key=${encodeURIComponent(existing.key)}`, {
      method: 'DELETE',
    }).catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setError('Could not remove it');
      return;
    }
    onDone();
  }

  const idBase = `${kind.key}-${existing?.key ?? 'new'}`;
  return (
    <Card
      title={existing ? `${kind.label} · ${existing.name}` : `New ${kind.label} connector`}
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
            value={name}
            onChange={(e) => setName(e.target.value)}
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
            value={myDomain}
            onChange={(e) => setMyDomain(e.target.value)}
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
          <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
          This is a sandbox
        </label>
        <div>
          <label htmlFor={`${idBase}-client-id`} className={labelClass}>
            Consumer key
          </label>
          <input
            id={`${idBase}-client-id`}
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
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
            required={!existing?.hasClientSecret}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={existing?.hasClientSecret ? 'Stored — leave blank to keep' : ''}
            className={`${inputClass} font-mono`}
          />
        </div>
        <fieldset>
          <legend className={labelClass}>What people may let Renkei do in this org</legend>
          <ScopePicker
            groups={kind.scopeGroups}
            options={kind.scopeOptions}
            checked={checkedIds}
            onToggle={toggleOption}
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
          !sandbox && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={productionChanges}
                onChange={(e) => setProductionChanges(e.target.checked)}
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
                value={excludedObjects}
                onChange={(e) => setExcludedObjects(e.target.value)}
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
                value={excludedFields}
                onChange={(e) => setExcludedFields(e.target.value)}
                placeholder="Contact.Diagnosis__c"
                className={`${inputClass} font-mono`}
              />
              <p className={hintClass}>Object.Field API names, one per line.</p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={hideRestricted}
                onChange={(e) => setHideRestricted(e.target.checked)}
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
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <SaveRow busy={busy} notice={notice} error={error} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onCancel} className="text-sm underline">
            Cancel
          </button>
          {existing &&
            (confirmingRemove ? (
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
                  onClick={() => setConfirmingRemove(false)}
                  className="underline"
                >
                  Keep it
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingRemove(true)}
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
