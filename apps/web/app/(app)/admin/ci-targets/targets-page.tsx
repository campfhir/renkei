'use client';

/**
 * The Targets page: the service accounts Renkei reads each host's runners
 * with, the targets — each a name and the runner labels a pipeline's
 * runs-on gets on Bitbucket and on GitHub — with the runners that fit
 * them, and the runners in no target, each one click from becoming a
 * target. Every rule is targets-page.model.ts's; this makes the calls.
 */

import { useCallback, useEffect, useReducer, useState } from 'react';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import {
  HOST_NAMES,
  accountCards,
  accountProblems,
  accountRequest,
  initialTargetsPage,
  knownLabels,
  looseRows,
  targetCards,
  targetFormProblems,
  targetRequest,
  targetsPageReducer,
  type HostKey,
  type TargetsPageData,
} from './targets-page.model';

const input =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
const label = 'flex flex-col gap-1 text-xs font-semibold text-gray-700 dark:text-gray-300';
const hint = 'font-normal text-gray-500';
const secondary =
  'rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900';
const primary =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const tag =
  'inline-block rounded border border-gray-200 bg-gray-50 px-1.5 py-px font-mono text-[11px] text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300';
const TONES = {
  good: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  bad: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  none: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

export default function TargetsPage() {
  const [state, dispatch] = useReducer(targetsPageReducer, initialTargetsPage);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (options: { fresh?: boolean; notice?: string } = {}) => {
    const result = await getJson<TargetsPageData>(
      `/api/admin/ci-targets${options.fresh ? '?fresh=1' : ''}`
    );
    setNow(Date.now());
    if (result.data)
      dispatch({
        type: 'loaded',
        data: result.data,
        ...(options.notice ? { notice: options.notice } : {}),
      });
    else dispatch({ type: 'failed', error: result.error ?? 'The targets could not be read.' });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    dispatch({ type: 'sent', busy: 'sync' });
    await load({ fresh: true });
  };

  const saveAccount = async () => {
    if (!state.account) return;
    const request = accountRequest(state.account);
    dispatch({ type: 'sent', busy: 'account' });
    const result = await sendJsonFull(request.url, 'PUT', request.body);
    if (result.error) dispatch({ type: 'failed', error: result.error });
    else await load({ fresh: true, notice: `${HOST_NAMES[state.account.host]} account saved.` });
  };

  const removeAccount = async (host: HostKey) => {
    if (
      !window.confirm(`Forget the ${HOST_NAMES[host]} service account? Targets keep their labels.`)
    )
      return;
    dispatch({ type: 'sent', busy: 'account' });
    const result = await sendJsonFull(`/api/admin/ci-accounts/${host}`, 'DELETE');
    if (result.error) dispatch({ type: 'failed', error: result.error });
    else await load({ notice: `${HOST_NAMES[host]} account removed.` });
  };

  const saveTarget = async () => {
    if (!state.target) return;
    const request = targetRequest(state.target);
    dispatch({ type: 'sent', busy: 'target' });
    const result = await sendJsonFull<{ problems?: string[] }>(
      request.url,
      request.method,
      request.body
    );
    if (result.error) {
      dispatch({
        type: 'failed',
        error: result.error,
        problems: Array.isArray(result.data?.problems) ? result.data.problems : [],
      });
    } else await load({ notice: `Target ${request.body.name} saved.` });
  };

  const removeTarget = async (id: string, name: string) => {
    if (
      !window.confirm(
        `Delete the target ${name}? Pipelines already written keep their runner labels.`
      )
    )
      return;
    dispatch({ type: 'sent', busy: 'delete' });
    const result = await sendJsonFull(`/api/admin/ci-targets/${id}`, 'DELETE');
    if (result.error) dispatch({ type: 'failed', error: result.error });
    else await load({ notice: `Target ${name} deleted.` });
  };

  const { data } = state;
  if (!data) {
    return state.error ? (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {state.error}
      </p>
    ) : (
      <p className="text-sm text-gray-500">Reading the targets and runners…</p>
    );
  }

  const accountForm = state.account;
  const targetForm = state.target;
  const loose = looseRows(data);

  return (
    <div className="space-y-6">
      {state.notice ? (
        <p
          role="status"
          className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-300"
        >
          {state.notice}
        </p>
      ) : null}
      {state.error && !targetForm && !accountForm ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {state.error}
        </p>
      ) : null}

      <section aria-label="Service accounts" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-base font-semibold">Service accounts</h2>
          <button
            type="button"
            className={secondary}
            disabled={state.busy !== null}
            onClick={() => void sync()}
          >
            {state.busy === 'sync' ? 'Reading…' : 'Read runners now'}
          </button>
        </div>
        <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2">
          {accountCards(data, now).map((card) => (
            <div
              key={card.host}
              className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
              data-testid={`account-${card.host}`}
            >
              <div className="flex items-center gap-2">
                <h3 className="min-w-0 flex-1 text-sm font-semibold break-words">{card.title}</h3>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    card.state === 'connected'
                      ? TONES.good
                      : card.state === 'failing'
                        ? TONES.bad
                        : TONES.none
                  }`}
                >
                  {card.state === 'connected'
                    ? 'Connected'
                    : card.state === 'failing'
                      ? 'Cannot read'
                      : 'Not connected'}
                </span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">{card.how}</p>
              <p
                className={`text-xs ${card.state === 'failing' ? 'text-red-700 dark:text-red-400' : 'text-gray-500'}`}
              >
                {card.status}
              </p>
              {accountForm?.host === card.host ? (
                <div className="space-y-2 border-t border-gray-200 pt-2 dark:border-gray-800">
                  {card.host === 'bitbucket' ? (
                    <>
                      <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2">
                        <label className={label}>
                          Workspace
                          <input
                            className={`${input} font-mono`}
                            value={accountForm.account}
                            placeholder="acme"
                            onChange={(e) =>
                              dispatch({ type: 'accountField', patch: { account: e.target.value } })
                            }
                          />
                        </label>
                        <label className={label}>
                          Signs in with
                          <select
                            className={input}
                            value={accountForm.auth}
                            onChange={(e) =>
                              dispatch({
                                type: 'accountField',
                                patch: { auth: e.target.value === 'basic' ? 'basic' : 'bearer' },
                              })
                            }
                          >
                            <option value="bearer">A workspace access token</option>
                            <option value="basic">A bot account’s API token</option>
                          </select>
                        </label>
                      </div>
                      {accountForm.auth === 'basic' ? (
                        <label className={label}>
                          Bot account’s email
                          <input
                            className={input}
                            type="email"
                            value={accountForm.email}
                            onChange={(e) =>
                              dispatch({ type: 'accountField', patch: { email: e.target.value } })
                            }
                          />
                        </label>
                      ) : null}
                      <label className={label}>
                        {accountForm.auth === 'basic' ? 'API token' : 'Access token'}
                        <input
                          className={`${input} font-mono`}
                          type="password"
                          autoComplete="off"
                          value={accountForm.secret}
                          placeholder={
                            accountForm.hasSecret ? 'Stored — leave blank to keep it' : ''
                          }
                          onChange={(e) =>
                            dispatch({ type: 'accountField', patch: { secret: e.target.value } })
                          }
                        />
                        <span className={hint}>
                          Needs read access to the workspace’s runners. Never shown again once
                          saved.
                        </span>
                      </label>
                    </>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2">
                        <label className={label}>
                          Organization
                          <input
                            className={`${input} font-mono`}
                            value={accountForm.account}
                            placeholder="acme-labs"
                            onChange={(e) =>
                              dispatch({ type: 'accountField', patch: { account: e.target.value } })
                            }
                          />
                        </label>
                        <label className={label}>
                          App ID
                          <input
                            className={`${input} font-mono`}
                            value={accountForm.appId}
                            inputMode="numeric"
                            onChange={(e) =>
                              dispatch({ type: 'accountField', patch: { appId: e.target.value } })
                            }
                          />
                        </label>
                      </div>
                      <label className={label}>
                        Private key
                        <textarea
                          className={`${input} font-mono text-xs`}
                          rows={4}
                          spellCheck={false}
                          value={accountForm.secret}
                          placeholder={
                            accountForm.hasSecret
                              ? 'Stored — leave blank to keep it'
                              : '-----BEGIN RSA PRIVATE KEY-----'
                          }
                          onChange={(e) =>
                            dispatch({ type: 'accountField', patch: { secret: e.target.value } })
                          }
                        />
                        <span className={hint}>
                          The App needs the organization permission “Self-hosted runners: Read”, and
                          must be installed on the organization. Never shown again once saved.
                        </span>
                      </label>
                    </>
                  )}
                  {state.error ? (
                    <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                      {state.error}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={primary}
                      disabled={state.busy !== null || accountProblems(accountForm).length > 0}
                      onClick={() => void saveAccount()}
                    >
                      {state.busy === 'account' ? 'Saving…' : 'Save and read runners'}
                    </button>
                    <button
                      type="button"
                      className={secondary}
                      onClick={() => dispatch({ type: 'closeAccount' })}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={secondary}
                    disabled={state.busy !== null}
                    onClick={() => dispatch({ type: 'openAccount', host: card.host })}
                  >
                    {card.state === 'none' ? `Connect ${HOST_NAMES[card.host]}` : 'Change'}
                  </button>
                  {card.state !== 'none' ? (
                    <button
                      type="button"
                      className="text-sm text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                      disabled={state.busy !== null}
                      onClick={() => void removeAccount(card.host)}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section aria-label="Runner targets" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-base font-semibold">Runner targets</h2>
          <button
            type="button"
            className={primary}
            disabled={state.busy !== null}
            onClick={() => dispatch({ type: 'newTarget' })}
          >
            New target
          </button>
        </div>

        {targetForm ? (
          <div
            className="space-y-3 rounded-lg border border-blue-200 bg-blue-50/40 p-3 dark:border-blue-900 dark:bg-blue-950/20"
            data-testid="target-form"
          >
            <h3 className="text-sm font-semibold">
              {targetForm.id ? `Change ${targetForm.name}` : 'New target'}
            </h3>
            <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
              <label className={label}>
                Name
                <input
                  className={`${input} font-mono`}
                  value={targetForm.name}
                  placeholder="onprem-app"
                  onChange={(e) =>
                    dispatch({ type: 'targetField', patch: { name: e.target.value } })
                  }
                />
                <span className={hint}>What pipelines and deploy blocks pick.</span>
              </label>
              <label className={label}>
                Description
                <input
                  className={input}
                  value={targetForm.description}
                  placeholder="Application servers in the data centre"
                  onChange={(e) =>
                    dispatch({ type: 'targetField', patch: { description: e.target.value } })
                  }
                />
              </label>
              {(['bitbucket', 'github'] as const).map((host) => (
                <label key={host} className={label}>
                  {HOST_NAMES[host]} runner labels
                  <input
                    className={`${input} font-mono`}
                    value={targetForm[host]}
                    placeholder={
                      host === 'bitbucket'
                        ? 'self.hosted, linux, onprem-app'
                        : 'self-hosted, linux, onprem-app'
                    }
                    onChange={(e) =>
                      dispatch({ type: 'targetField', patch: { [host]: e.target.value } })
                    }
                  />
                  <span className={hint}>
                    {knownLabels(data, host).length > 0
                      ? `Its runners carry: ${knownLabels(data, host).join(', ')}.`
                      : `Leave empty if the target has no ${HOST_NAMES[host]} runners.`}
                  </span>
                </label>
              ))}
            </div>
            {targetFormProblems(targetForm).length > 0 ||
            state.problems.length > 0 ||
            state.error ? (
              <ul
                role="alert"
                className="list-disc space-y-0.5 pl-5 text-sm text-red-700 dark:text-red-400"
              >
                {state.error && state.problems.length === 0 ? <li>{state.error}</li> : null}
                {[...new Set([...state.problems, ...targetFormProblems(targetForm)])].map(
                  (problem) => (
                    <li key={problem}>{problem}</li>
                  )
                )}
              </ul>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={primary}
                disabled={state.busy !== null || targetFormProblems(targetForm).length > 0}
                onClick={() => void saveTarget()}
              >
                {state.busy === 'target' ? 'Saving…' : 'Save target'}
              </button>
              <button
                type="button"
                className={secondary}
                onClick={() => dispatch({ type: 'closeTarget' })}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {data.targets.length === 0 && !targetForm ? (
          <p className="rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
            No targets yet. Make one from a runner below, or start a new one.
          </p>
        ) : null}

        {targetCards(data).map((card) => (
          <div
            key={card.id}
            className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-800"
            data-testid="target-card"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-mono text-sm font-semibold">{card.name}</h3>
              {card.description ? (
                <span className="min-w-0 flex-[1_1_240px] text-sm text-gray-600 dark:text-gray-400">
                  {card.description}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONES[card.tone]}`}>
                {card.health}
              </span>
            </div>
            <div className="grid grid-cols-1 items-start gap-2 md:grid-cols-2">
              {card.hosts.map((host) => (
                <div
                  key={host.host}
                  className="space-y-1 rounded-md border border-gray-100 bg-gray-50/70 p-2 dark:border-gray-800 dark:bg-gray-900/40"
                >
                  <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                    {host.name}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {host.labels.map((l) => (
                      <span key={l} className={tag}>
                        {l}
                      </span>
                    ))}
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-400">{host.runners}</div>
                </div>
              ))}
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                className="text-sm text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                disabled={state.busy !== null}
                onClick={() => dispatch({ type: 'editTarget', id: card.id })}
              >
                Change
              </button>
              <button
                type="button"
                className="text-sm text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                disabled={state.busy !== null}
                onClick={() => void removeTarget(card.id, card.name)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </section>

      {loose.length > 0 ? (
        <section
          aria-label="Runners in no target"
          className="space-y-2 rounded-lg border border-dashed border-gray-300 p-3 dark:border-gray-700"
        >
          <h2 className="text-sm font-semibold">
            {loose.length} runner{loose.length === 1 ? ' is' : 's are'} in no target
          </h2>
          <ul className="space-y-2">
            {loose.map((row) => (
              <li key={row.key} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs">{row.runner.name}</span>
                <span className="text-gray-500">{row.host} ·</span>
                {row.runner.labels.map((l) => (
                  <span key={l} className={tag}>
                    {l}
                  </span>
                ))}
                <span
                  className={
                    row.status === 'online' || row.status === 'busy'
                      ? 'text-green-700 dark:text-green-400'
                      : 'text-gray-500'
                  }
                >
                  {row.status}
                </span>
                <button
                  type="button"
                  className="ml-auto text-sm font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                  disabled={state.busy !== null}
                  onClick={() => dispatch({ type: 'targetFromRunner', runner: row.runner })}
                >
                  Make a target from these labels
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        aria-label="Cloud targets"
        className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-900/40"
      >
        <div className="min-w-0 flex-[1_1_420px]">
          <h2 className="text-sm font-semibold">Azure App Service and Container Instances</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Coming later: add a subscription and Renkei sets up sign-in from pipelines with OIDC, so
            no Azure secret is stored in Bitbucket or GitHub. Each web app or container group
            becomes a target.
          </p>
        </div>
      </section>
    </div>
  );
}
