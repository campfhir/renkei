'use client';

/**
 * An environment's health check-ins, on its card of the Environments page.
 *
 * Optional, and the application developer's to implement: the application
 * tells Renkei how it is, with a token issued here for this environment
 * (lib/ci/health-rules.ts has the interface). Until a token is issued
 * nothing shows but the way to set it up; once one is, the environment
 * says how its application last said it was — or that a check-in is late.
 *
 * A token is shown once, here, when it is issued: Renkei keeps only its
 * hash. It can be copied, or saved straight to the host as the
 * environment's secret for the pipeline to hand to the application; that
 * save goes through the project's variables route, not through a model.
 * What this decides is health-checkins.model.ts.
 */

import { useReducer } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { sendJsonFull } from '@/lib/fetch-json';
import { HEALTH_TOKEN_VARIABLE, HEALTH_URL_VARIABLE, type HealthView } from '@/lib/ci/health-rules';
import {
  checkInExample,
  healthLine,
  healthUiReducer,
  initialHealthUi,
  replaceQuestion,
  revokeQuestion,
  variablesRequest,
  type HealthTone,
} from './health-checkins.model';
import { linkButtonClass, secondaryButtonClass } from './pipeline-parts';

const TONE: Record<HealthTone, string> = {
  good: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  bad: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  none: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

export default function HealthCheckins({
  projectId,
  environment,
  health,
  canEdit,
  now,
  onChanged,
}: {
  projectId: string;
  environment: string;
  /** The environment's check-ins; null when no token was issued for it. */
  health: HealthView | null;
  canEdit: boolean;
  /** The page's clock; null until it is in the browser. */
  now: number | null;
  /** A token was issued or taken away: read the page again. */
  onChanged: () => void;
}) {
  const [state, dispatch] = useReducer(healthUiReducer, initialHealthUi);
  const url = `/api/code/projects/${projectId}/health-token`;

  const issue = async () => {
    if (health && !window.confirm(replaceQuestion(environment))) return;
    dispatch({ type: 'sent' });
    const result = await sendJsonFull<{ token: string; url: string; environment: string }>(
      url,
      'POST',
      { environment }
    );
    if (result.error || !result.data) {
      dispatch({ type: 'failed', error: result.error ?? 'The token was not issued.' });
      return;
    }
    dispatch({ type: 'issued', issued: result.data });
    onChanged();
  };

  const revoke = async () => {
    if (!window.confirm(revokeQuestion(environment))) return;
    dispatch({ type: 'sent' });
    const result = await sendJsonFull(url, 'DELETE', { environment });
    if (result.error) {
      dispatch({ type: 'failed', error: result.error });
      return;
    }
    dispatch({ type: 'revoked' });
    onChanged();
  };

  /** Straight to the host, as the Variables tab saves: the address plain, the token a secret. */
  const saveAsVariables = async () => {
    if (!state.issued) return;
    dispatch({ type: 'sent' });
    const result = await sendJsonFull<{ errors: string[]; environmentCreated?: boolean }>(
      `/api/code/projects/${projectId}/variables`,
      'PUT',
      variablesRequest(state.issued)
    );
    if (result.error || !result.data) {
      dispatch({ type: 'failed', error: result.error ?? 'The variables were not saved.' });
      return;
    }
    dispatch({
      type: 'variablesSaved',
      environmentCreated: Boolean(result.data.environmentCreated),
      errors: result.data.errors,
    });
  };

  const copy = async (what: 'token' | 'example', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      dispatch({ type: 'copied', what });
    } catch {
      // No clipboard here: the text is on screen to select.
    }
  };

  const line = health && now !== null ? healthLine(health, now) : null;
  const issued = state.issued;
  if (!health && !issued && !canEdit) return null;

  return (
    <div className="mt-3 space-y-2" data-testid="health-checkins">
      {line ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="text-xs font-semibold tracking-wide text-gray-500 uppercase">
            Health
          </span>
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${TONE[line.tone]}`}>
            {line.label}
          </span>
          <span className="text-xs text-gray-500">{line.detail}</span>
          {line.message ? <span className="text-xs">“{line.message}”</span> : null}
          {line.version ? (
            <span className="font-mono text-xs text-gray-500">{line.version}</span>
          ) : null}
        </p>
      ) : null}

      {canEdit && !issued ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
          {health ? (
            <>
              <span>
                Token ending <span className="font-mono">{health.tokenHint}</span>.
              </span>
              <button
                type="button"
                disabled={state.busy}
                onClick={() => void issue()}
                className={linkButtonClass}
              >
                Issue a new token
              </button>
              <button
                type="button"
                disabled={state.busy}
                onClick={() => void revoke()}
                className="text-xs font-medium whitespace-nowrap text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
              >
                Stop taking check-ins
              </button>
            </>
          ) : (
            <>
              <span>
                Optional: the application can tell Renkei how it is after it is deployed, with a
                token for {environment}.
              </span>
              <button
                type="button"
                disabled={state.busy}
                onClick={() => void issue()}
                className={linkButtonClass}
              >
                Set up health check-ins
              </button>
            </>
          )}
        </p>
      ) : null}

      {issued ? (
        <section
          aria-label={`The health token for ${issued.environment}`}
          className="space-y-2 rounded-md border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/30"
        >
          <p className="text-sm font-semibold">The health token for {issued.environment}</p>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            This is the only time it is shown: Renkei keeps a fingerprint of it, not the token. Give
            it to the application as a secret. It can do one thing — say how {issued.environment}{' '}
            is.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code
              aria-label="The token"
              className="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1.5 font-mono text-xs break-all dark:border-gray-700 dark:bg-gray-900"
            >
              {issued.token}
            </code>
            <button
              type="button"
              onClick={() => void copy('token', issued.token)}
              className={`inline-flex items-center gap-1 ${secondaryButtonClass}`}
            >
              <Icon
                path={state.copied === 'token' ? ICONS.check : ICONS.copy}
                className="h-3.5 w-3.5"
              />
              {state.copied === 'token' ? 'Copied' : 'Copy the token'}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={state.busy || state.saved !== null}
              onClick={() => void saveAsVariables()}
              className={secondaryButtonClass}
            >
              {state.busy ? 'Saving…' : `Save it for ${issued.environment}’s pipeline`}
            </button>
            <span className="text-xs text-gray-600 dark:text-gray-400">
              As <span className="font-mono">{HEALTH_URL_VARIABLE}</span> and the secret{' '}
              <span className="font-mono">{HEALTH_TOKEN_VARIABLE}</span> in {issued.environment}’s
              variables, for the deploy to hand to the application.
            </span>
          </div>
          {state.saved ? (
            <p role="status" className="text-xs text-green-700 dark:text-green-400">
              {state.saved}
            </p>
          ) : null}
          <p className="text-xs text-gray-600 dark:text-gray-400">
            The application POSTs its status — <span className="font-mono">starting</span>,{' '}
            <span className="font-mono">healthy</span>, <span className="font-mono">degraded</span>,{' '}
            <span className="font-mono">error</span> or <span className="font-mono">stopping</span>{' '}
            — and may say when to expect the next. Without that, one is expected every 60 minutes; a
            late one shows as potentially failing, and three missed in a row as failed.
          </p>
          <pre
            aria-label="A check-in, as a command"
            className="overflow-auto rounded-md border border-gray-200 bg-white p-2 font-mono text-xs leading-relaxed dark:border-gray-700 dark:bg-gray-900"
          >
            {checkInExample(issued)}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void copy('example', checkInExample(issued))}
              className={`inline-flex items-center gap-1 ${secondaryButtonClass}`}
            >
              <Icon
                path={state.copied === 'example' ? ICONS.check : ICONS.copy}
                className="h-3.5 w-3.5"
              />
              {state.copied === 'example' ? 'Copied' : 'Copy the command'}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: 'dismissed' })}
              className={`ml-auto ${secondaryButtonClass}`}
            >
              I have it
            </button>
          </div>
        </section>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
