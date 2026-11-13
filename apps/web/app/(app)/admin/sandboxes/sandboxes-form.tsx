'use client';

import { useReducer, type FormEvent, type ReactNode } from 'react';
import { sendJsonFull } from '@/lib/fetch-json';
import type { SandboxesView } from '@/lib/sandboxes-admin';
import {
  asksEntraAllowed,
  badge,
  canSubmit,
  clientSecretPlaceholder,
  envPlaceholder,
  init,
  orchestratorLine,
  reducer,
  requestBody,
  saveLabel,
  testLabel,
  usesServicePrincipal,
} from './sandboxes-form.model';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';
const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';
const sectionClass =
  'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950';

const BADGE_CLASS = {
  Enabled: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  Disabled: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
  'Not configured': 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
} as const;

const LINE_CLASS = {
  ok: 'border-green-200 bg-green-50 text-green-900 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200',
  warn: 'border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-900/60 dark:bg-yellow-950/30 dark:text-yellow-200',
  off: 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300',
} as const;

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className={labelClass} htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? <p className={hintClass}>{hint}</p> : null}
    </div>
  );
}

export default function SandboxesForm({ initial }: { initial: SandboxesView | null }) {
  const [state, dispatch] = useReducer(reducer, initial, init);
  const { draft } = state;
  const line = orchestratorLine(state);
  const shown = badge(state);

  async function save(event: FormEvent) {
    event.preventDefault();
    dispatch({ type: 'sent', what: 'save' });
    const result = await sendJsonFull<SandboxesView>(
      '/api/admin/sandboxes',
      'PUT',
      requestBody(state)
    );
    if (result.error || !result.data) {
      dispatch({ type: 'failed', message: result.error ?? 'The setup could not be saved.' });
      return;
    }
    dispatch({ type: 'saved', view: result.data });
  }

  async function test() {
    dispatch({ type: 'sent', what: 'test' });
    const result = await sendJsonFull<{ ok: boolean; detail: string }>(
      '/api/admin/sandboxes/test-connection',
      'POST',
      requestBody(state)
    );
    if (result.error || !result.data) {
      dispatch({ type: 'failed', message: result.error ?? 'The test could not run.' });
      return;
    }
    dispatch({ type: 'tested', ok: result.data.ok, detail: result.data.detail });
  }

  const azureText = (
    key:
      | 'subscriptionId'
      | 'resourceGroup'
      | 'sandboxGroup'
      | 'region'
      | 'endpoint'
      | 'diskImage'
      | 'cpu'
      | 'memory'
      | 'disk'
      | 'vnetConnection'
      | 'tenantId'
      | 'clientId',
    label: string,
    placeholder: string,
    hint?: string
  ) => (
    <Field id={`sandboxes-azure-${key}`} label={label} hint={hint}>
      <input
        id={`sandboxes-azure-${key}`}
        className={inputClass}
        value={draft.azure[key]}
        onChange={(event) => dispatch({ type: 'setAzure', patch: { [key]: event.target.value } })}
        placeholder={placeholder}
        autoComplete="off"
      />
    </Field>
  );

  const dockerText = (
    key: 'image' | 'host' | 'networks' | 'publishHost' | 'memoryMb' | 'cpus',
    label: string,
    placeholder: string,
    hint?: string
  ) => (
    <Field id={`sandboxes-docker-${key}`} label={label} hint={hint}>
      <input
        id={`sandboxes-docker-${key}`}
        className={inputClass}
        value={draft.docker[key]}
        onChange={(event) => dispatch({ type: 'setDocker', patch: { [key]: event.target.value } })}
        placeholder={placeholder}
        autoComplete="off"
      />
    </Field>
  );

  return (
    <form onSubmit={save} className="space-y-4">
      <p className={`rounded-md border px-3 py-2 text-sm ${LINE_CLASS[line.tone]}`}>{line.text}</p>

      <section className={sectionClass}>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="font-semibold">Where sandboxes are made</h2>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE_CLASS[shown]}`}>
            {shown}
          </span>
        </div>
        <div className="space-y-4">
          <Field
            id="sandboxes-provider"
            label="Provider"
            hint="Azure Container Apps sandboxes in production: a microVM per sandbox. Docker for a developer’s machine or a single host."
          >
            <select
              id="sandboxes-provider"
              className={inputClass}
              value={draft.provider}
              onChange={(event) =>
                dispatch({
                  type: 'set',
                  patch: { provider: event.target.value === 'docker' ? 'docker' : 'azure' },
                })
              }
            >
              <option value="azure">Azure Container Apps sandboxes</option>
              <option value="docker">Docker engine</option>
            </select>
          </Field>

          <Field
            id="sandboxes-callbackUrl"
            label="Orchestrator address, as sandboxes reach it"
            hint="A sandbox has no database access and is created with no secret but its own key: its worker asks the orchestrator, at this address, for its sealed secrets and for every data store call."
          >
            <input
              id="sandboxes-callbackUrl"
              className={inputClass}
              value={draft.callbackUrl}
              onChange={(event) =>
                dispatch({ type: 'set', patch: { callbackUrl: event.target.value } })
              }
              placeholder="https://orchestrator.internal:8097"
              autoComplete="off"
            />
          </Field>

          {draft.provider === 'azure' ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {azureText(
                  'subscriptionId',
                  'Subscription id',
                  '00000000-0000-0000-0000-000000000000'
                )}
                {azureText('resourceGroup', 'Resource group', 'my-resource-group')}
                {azureText('sandboxGroup', 'Sandbox group', 'my-sandbox-group')}
                {azureText(
                  'region',
                  'Region',
                  'eastus2',
                  'The sandbox group’s region, as its short name.'
                )}
                {azureText(
                  'diskImage',
                  'Disk image',
                  'renkei-sandbox',
                  'The disk image in the group that sandboxes start from: the sandbox image, imported.'
                )}
                {azureText(
                  'vnetConnection',
                  'VNet connection (optional)',
                  'private',
                  'The group’s connection to the network the database and the delegate are on.'
                )}
                {azureText('cpu', 'CPU', '2000m')}
                {azureText('memory', 'Memory', '4096Mi')}
                {azureText('disk', 'Disk', '40Gi')}
                <Field
                  id="sandboxes-azure-suspendMode"
                  label="Suspend keeps"
                  hint="Memory keeps what was running across a suspension; Disk keeps files only."
                >
                  <select
                    id="sandboxes-azure-suspendMode"
                    className={inputClass}
                    value={draft.azure.suspendMode}
                    onChange={(event) =>
                      dispatch({
                        type: 'setAzure',
                        patch: { suspendMode: event.target.value === 'Disk' ? 'Disk' : 'Memory' },
                      })
                    }
                  >
                    <option value="Memory">Memory and disk</option>
                    <option value="Disk">Disk only</option>
                  </select>
                </Field>
              </div>

              <h3 className="pt-2 text-sm font-semibold">Identity</h3>
              <p className={hintClass}>
                Who the orchestrator signs in to Azure as. It needs the “Container Apps SandboxGroup
                Data Owner” role on the sandbox group. Leave both ids blank to use the
                orchestrator’s own managed identity.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {azureText(
                  'tenantId',
                  'Tenant id (optional)',
                  '00000000-0000-0000-0000-000000000000'
                )}
                {azureText(
                  'clientId',
                  'Client id (optional)',
                  '00000000-0000-0000-0000-000000000000'
                )}
              </div>
              {usesServicePrincipal(state) ? (
                <Field
                  id="sandboxes-azure-clientSecret"
                  label="Client secret"
                  hint="Sealed at rest and never shown again; a blank field keeps the stored one."
                >
                  <input
                    id="sandboxes-azure-clientSecret"
                    type="password"
                    className={inputClass}
                    value={draft.azureClientSecret}
                    onChange={(event) =>
                      dispatch({ type: 'set', patch: { azureClientSecret: event.target.value } })
                    }
                    placeholder={clientSecretPlaceholder(state)}
                    autoComplete="new-password"
                  />
                </Field>
              ) : null}

              <h3 className="pt-2 text-sm font-semibold">Who may call a sandbox</h3>
              <Field
                id="sandboxes-azure-portAuth"
                label="Worker port"
                hint="Microsoft Entra: the platform admits only the identities below, and the sandbox’s own key is checked as well. Sandbox key only: the key alone."
              >
                <select
                  id="sandboxes-azure-portAuth"
                  className={inputClass}
                  value={draft.azure.portAuth}
                  onChange={(event) =>
                    dispatch({
                      type: 'setAzure',
                      patch: {
                        portAuth: event.target.value === 'anonymous' ? 'anonymous' : 'entra',
                      },
                    })
                  }
                >
                  <option value="entra">Microsoft Entra</option>
                  <option value="anonymous">Sandbox key only</option>
                </select>
              </Field>
              {asksEntraAllowed(state) ? (
                <Field
                  id="sandboxes-azure-entraAllowed"
                  label="Allowed identities"
                  hint="One per line: the identity the orchestrator calls sandboxes as (an email or user principal name)."
                >
                  <textarea
                    id="sandboxes-azure-entraAllowed"
                    className={inputClass}
                    rows={2}
                    value={draft.azure.entraAllowed}
                    onChange={(event) =>
                      dispatch({ type: 'setAzure', patch: { entraAllowed: event.target.value } })
                    }
                    placeholder="orchestrator@contoso.com"
                  />
                </Field>
              ) : null}
              <Field
                id="sandboxes-azure-allowedCidrs"
                label="Allowed source ranges (optional)"
                hint="One IPv4 range per line. Empty admits any address that is otherwise let in."
              >
                <textarea
                  id="sandboxes-azure-allowedCidrs"
                  className={inputClass}
                  rows={2}
                  value={draft.azure.allowedCidrs}
                  onChange={(event) =>
                    dispatch({ type: 'setAzure', patch: { allowedCidrs: event.target.value } })
                  }
                  placeholder="10.0.0.0/8"
                />
              </Field>
            </>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {dockerText(
                  'image',
                  'Sandbox image',
                  'renkei-sandbox:latest',
                  'Must already be on the engine.'
                )}
                {dockerText(
                  'host',
                  'Engine (optional)',
                  'unix:///var/run/docker.sock',
                  'Blank is the orchestrator’s local socket.'
                )}
                {dockerText(
                  'networks',
                  'Networks',
                  'renkei-sandbox',
                  'Comma-separated. A sandbox’s address is read from the first.'
                )}
                {dockerText(
                  'publishHost',
                  'Publish on (optional)',
                  '127.0.0.1',
                  'For an orchestrator and app run on the host: each sandbox’s port on this address.'
                )}
                {dockerText('memoryMb', 'Memory (MB)', '4096')}
                {dockerText('cpus', 'CPUs', '0', '0 for no ceiling.')}
                <Field
                  id="sandboxes-docker-suspend"
                  label="Suspend by"
                  hint="Stopping keeps the disk and gives memory back. Pausing keeps what was running, and its memory."
                >
                  <select
                    id="sandboxes-docker-suspend"
                    className={inputClass}
                    value={draft.docker.suspend}
                    onChange={(event) =>
                      dispatch({
                        type: 'setDocker',
                        patch: { suspend: event.target.value === 'pause' ? 'pause' : 'stop' },
                      })
                    }
                  >
                    <option value="stop">Stopping</option>
                    <option value="pause">Pausing</option>
                  </select>
                </Field>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={draft.docker.nestedEngine}
                  onChange={(event) =>
                    dispatch({ type: 'setDocker', patch: { nestedEngine: event.target.checked } })
                  }
                />
                <span>
                  Run sandboxes privileged, so each can run code project services
                  <span className={`block ${hintClass}`}>
                    A developer’s machine only: a privileged container is not isolated from its
                    host.
                  </span>
                </span>
              </label>
            </>
          )}
        </div>
      </section>

      <section className={sectionClass}>
        <h2 className="mb-3 font-semibold">When a sandbox is idle</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="sandboxes-idleSuspendMinutes"
            label="Suspend after (minutes)"
            hint="With nothing calling it. The next call resumes it."
          >
            <input
              id="sandboxes-idleSuspendMinutes"
              type="number"
              min={1}
              max={1440}
              className={inputClass}
              value={draft.idleSuspendMinutes}
              onChange={(event) =>
                dispatch({ type: 'set', patch: { idleSuspendMinutes: event.target.value } })
              }
            />
          </Field>
          <Field
            id="sandboxes-idleEvictHours"
            label="Evict after (hours)"
            hint="What it holds is archived to the organization’s storage first, and brought back into a new sandbox the next time it is needed."
          >
            <input
              id="sandboxes-idleEvictHours"
              type="number"
              min={1}
              max={8760}
              className={inputClass}
              value={draft.idleEvictHours}
              onChange={(event) =>
                dispatch({ type: 'set', patch: { idleEvictHours: event.target.value } })
              }
            />
          </Field>
        </div>
      </section>

      <section className={sectionClass}>
        <h2 className="mb-1 font-semibold">What a sandbox is started with</h2>
        <p className={`mb-3 ${hintClass}`}>
          The secrets every sandbox’s worker needs: the delegate’s address and the sandbox’s key for
          it, and its own sealing keys. They are never put in a sandbox’s environment: the
          orchestrator hands them to each sandbox sealed under that sandbox’s own key. Values are
          sealed at rest and never shown again; a blank value keeps the stored one. A database URL
          and the organization’s own encryption keys cannot be handed to a sandbox.
        </p>
        <ul className="space-y-2">
          {draft.env.map((row, index) => (
            <li key={index} className="flex flex-wrap items-center gap-2">
              <input
                aria-label={`Variable ${index + 1} name`}
                className={`${inputClass} font-mono sm:w-72`}
                value={row.name}
                onChange={(event) =>
                  dispatch({ type: 'envNamed', index, name: event.target.value })
                }
                placeholder="NAME"
                autoComplete="off"
              />
              <input
                aria-label={`Variable ${index + 1} value`}
                type="password"
                className={`${inputClass} min-w-0 flex-1`}
                value={row.value}
                onChange={(event) =>
                  dispatch({ type: 'envValued', index, value: event.target.value })
                }
                placeholder={envPlaceholder(state, row.name)}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => dispatch({ type: 'envRemoved', index })}
                className="rounded-md border border-gray-300 px-2 py-2 text-xs hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
                aria-label={`Remove variable ${row.name || index + 1}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => dispatch({ type: 'envAdded' })}
          className="mt-3 rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Add a variable
        </button>
      </section>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => dispatch({ type: 'set', patch: { enabled: event.target.checked } })}
        />
        Enabled
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit(state)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saveLabel(state)}
        </button>
        <button
          type="button"
          onClick={() => void test()}
          disabled={!canSubmit(state)}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          {testLabel(state)}
        </button>
      </div>
      {state.notice ? (
        <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-300">
          {state.notice}
        </p>
      ) : null}
      {state.error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm break-words text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
        >
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
