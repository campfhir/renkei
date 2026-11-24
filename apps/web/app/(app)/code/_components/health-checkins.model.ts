/**
 * An environment's health check-ins on the Environments page
 * (health-checkins.tsx): how the application says it is — shown only once
 * a token was issued for it — and issuing, replacing and taking away that
 * token. The interface an application speaks, and how lateness is read
 * from the last check-in and the clock, are lib/ci/health-rules.ts.
 * Tested in health-checkins.model.test.ts. The clock is passed in.
 */

import {
  HEALTH_TOKEN_VARIABLE,
  HEALTH_URL_VARIABLE,
  MISSES_TO_FAIL,
  readHealth,
  spanLabel,
  type HealthState,
  type HealthView,
} from '@/lib/ci/health-rules';

/** A token just issued: in the page's memory until it is dismissed, and nowhere else. */
export interface Issued {
  environment: string;
  token: string;
  url: string;
}

export interface HealthUiState {
  busy: boolean;
  error: string | null;
  issued: Issued | null;
  copied: 'token' | 'example' | null;
  /** What saving the token as the environment's variables did. */
  saved: string | null;
}

export type HealthUiAction =
  | { type: 'sent' }
  | { type: 'failed'; error: string }
  | { type: 'issued'; issued: Issued }
  /** The person has the token: it leaves the page. */
  | { type: 'dismissed' }
  | { type: 'revoked' }
  | { type: 'copied'; what: 'token' | 'example' }
  | { type: 'variablesSaved'; environmentCreated: boolean; errors: string[] };

export const initialHealthUi: HealthUiState = {
  busy: false,
  error: null,
  issued: null,
  copied: null,
  saved: null,
};

export function healthUiReducer(state: HealthUiState, action: HealthUiAction): HealthUiState {
  switch (action.type) {
    case 'sent':
      return { ...state, busy: true, error: null, saved: null };
    case 'failed':
      return { ...state, busy: false, error: action.error };
    case 'issued':
      return { ...state, busy: false, issued: action.issued, copied: null, saved: null };
    case 'dismissed':
      return { ...state, issued: null, copied: null, saved: null, error: null };
    case 'revoked':
      return { ...initialHealthUi };
    case 'copied':
      return { ...state, copied: action.what };
    case 'variablesSaved':
      return action.errors.length > 0
        ? { ...state, busy: false, error: `Not saved: ${action.errors.join('; ')}` }
        : {
            ...state,
            busy: false,
            saved: `Saved as ${HEALTH_URL_VARIABLE} and the secret ${HEALTH_TOKEN_VARIABLE} for ${state.issued?.environment ?? 'the environment'}.${action.environmentCreated ? ' The deployment environment was made on the host.' : ''}`,
          };
  }
}

export type HealthTone = 'good' | 'running' | 'warn' | 'bad' | 'none';

const LABEL: Record<HealthState, { label: string; tone: HealthTone }> = {
  waiting: { label: 'Waiting for the first check-in', tone: 'none' },
  starting: { label: 'Starting', tone: 'running' },
  healthy: { label: 'Healthy', tone: 'good' },
  degraded: { label: 'Degraded', tone: 'warn' },
  error: { label: 'Reporting an error', tone: 'bad' },
  stopping: { label: 'Stopping', tone: 'none' },
  late: { label: 'Potentially failing', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  stopped: { label: 'Stopped', tone: 'none' },
};

export interface HealthLine {
  label: string;
  tone: HealthTone;
  /** "Checked in 4 minutes ago · next expected within 5 minutes". */
  detail: string;
  /** What the application said, when it said something. */
  message: string | null;
  version: string | null;
}

function agoLabel(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return seconds < 45 ? 'just now' : `${spanLabel(seconds)} ago`;
}

/** How the environment's application is, as the page says it. */
export function healthLine(view: HealthView, now: number): HealthLine {
  const reading = readHealth(view, now);
  const look = LABEL[reading.state];
  const every = spanLabel(reading.intervalSeconds);
  const last = view.sentAt ? `Checked in ${agoLabel(view.sentAt, now)}` : '';
  const detail =
    reading.state === 'waiting'
      ? 'A token was issued; nothing has checked in with it yet.'
      : reading.state === 'late'
        ? `${last} · ${reading.missed} check-in${reading.missed === 1 ? '' : 's'} missed (one was expected every ${every}); marked failed at ${MISSES_TO_FAIL}`
        : reading.state === 'failed'
          ? `${last} · ${reading.missed} check-ins missed in a row (one was expected every ${every})`
          : reading.state === 'stopped'
            ? `${last}, saying it was stopping`
            : `${last} · next expected within ${every}`;
  return {
    label: look.label,
    tone: look.tone,
    detail,
    message: view.message,
    version: view.version,
  };
}

/** A check-in as a command, for trying the token and for copying into a script. */
export function checkInExample(
  issued: Pick<Issued, 'url'>,
  tokenWord = `$${HEALTH_TOKEN_VARIABLE}`
): string {
  return [
    `curl -sS -X POST ${JSON.stringify(issued.url)} \\`,
    `  -H "Authorization: Bearer ${tokenWord}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"status":"healthy","sentAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","nextCheckInSeconds":300}'`,
  ].join('\n');
}

/**
 * What saving the token for the application sends to the project's
 * variables route: the address as a plain variable and the token as a
 * secret, in the environment's own set.
 */
export function variablesRequest(issued: Issued): {
  scope: 'environment';
  environment: string;
  set: { key: string; value: string; secured: boolean }[];
  remove: string[];
} {
  return {
    scope: 'environment',
    environment: issued.environment,
    set: [
      { key: HEALTH_URL_VARIABLE, value: issued.url, secured: false },
      { key: HEALTH_TOKEN_VARIABLE, value: issued.token, secured: true },
    ],
    remove: [],
  };
}

export function replaceQuestion(environment: string): string {
  return `Issue a new token for ${environment}? The one in use stops working at once, so the application must be given the new one.`;
}

export function revokeQuestion(environment: string): string {
  return `Stop taking check-ins for ${environment}? Its token stops working and its health stops showing.`;
}
