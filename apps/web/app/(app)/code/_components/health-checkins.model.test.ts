import type { HealthView } from '@/lib/ci/health-rules';
import {
  checkInExample,
  healthLine,
  healthUiReducer,
  initialHealthUi,
  replaceQuestion,
  revokeQuestion,
  variablesRequest,
  type HealthUiAction,
  type HealthUiState,
  type Issued,
} from './health-checkins.model';

const SENT = Date.parse('2026-11-24T10:00:00Z');
const MIN = 60_000;

function view(patch: Partial<HealthView> = {}): HealthView {
  return {
    tokenHint: 'x9k2',
    issuedAt: '2026-11-20T08:00:00.000Z',
    status: 'healthy',
    message: null,
    version: null,
    sentAt: new Date(SENT).toISOString(),
    receivedAt: new Date(SENT).toISOString(),
    intervalSeconds: null,
    checkins: 12,
    ...patch,
  };
}

const ISSUED: Issued = {
  environment: 'dev',
  token: 'rkh_Zq3exampleTokenValue0000000000000000000x9k2',
  url: 'https://renkei.example/api/health/check-in',
};

function after(...actions: HealthUiAction[]): HealthUiState {
  return actions.reduce(healthUiReducer, initialHealthUi);
}

describe('how the environment’s application is, as the page says it', () => {
  it('a token nothing has used yet is waiting', () => {
    expect(
      healthLine(view({ status: null, sentAt: null, receivedAt: null, checkins: 0 }), SENT)
    ).toEqual({
      label: 'Waiting for the first check-in',
      tone: 'none',
      detail: 'A token was issued; nothing has checked in with it yet.',
      message: null,
      version: null,
    });
  });

  it('healthy says when it checked in and when the next is expected', () => {
    expect(healthLine(view(), SENT + 4 * MIN)).toEqual({
      label: 'Healthy',
      tone: 'good',
      detail: 'Checked in 4 minutes ago · next expected within 60 minutes',
      message: null,
      version: null,
    });
    expect(healthLine(view({ intervalSeconds: 300 }), SENT + 10_000).detail).toBe(
      'Checked in just now · next expected within 5 minutes'
    );
  });

  it('starting, degraded and stopping are said as the application said them', () => {
    expect(healthLine(view({ status: 'starting' }), SENT + MIN)).toMatchObject({
      label: 'Starting',
      tone: 'running',
    });
    expect(healthLine(view({ status: 'degraded' }), SENT + MIN)).toMatchObject({
      label: 'Degraded',
      tone: 'warn',
    });
    expect(healthLine(view({ status: 'stopping' }), SENT + MIN)).toMatchObject({
      label: 'Stopping',
      tone: 'none',
    });
  });

  it('an error carries what the application said, and its version', () => {
    expect(
      healthLine(
        view({ status: 'error', message: 'database unreachable', version: '1.4.2' }),
        SENT + MIN
      )
    ).toMatchObject({
      label: 'Reporting an error',
      tone: 'bad',
      message: 'database unreachable',
      version: '1.4.2',
    });
  });

  it('a late check-in is potentially failing, counting what was missed and where it fails', () => {
    expect(healthLine(view(), SENT + 70 * MIN)).toMatchObject({
      label: 'Potentially failing',
      tone: 'warn',
      detail:
        'Checked in 70 minutes ago · 1 check-in missed (one was expected every 60 minutes); marked failed at 3',
    });
    expect(healthLine(view(), SENT + 130 * MIN).detail).toBe(
      'Checked in 2 hours ago · 2 check-ins missed (one was expected every 60 minutes); marked failed at 3'
    );
  });

  it('three missed in a row is failed', () => {
    expect(healthLine(view({ intervalSeconds: 300 }), SENT + 17 * MIN)).toMatchObject({
      label: 'Failed',
      tone: 'bad',
      detail:
        'Checked in 17 minutes ago · 3 check-ins missed in a row (one was expected every 5 minutes)',
    });
  });

  it('one that said it was stopping and went quiet is stopped', () => {
    expect(healthLine(view({ status: 'stopping' }), SENT + 3 * 60 * MIN)).toMatchObject({
      label: 'Stopped',
      tone: 'none',
      detail: 'Checked in 3 hours ago, saying it was stopping',
    });
  });
});

describe('a token just issued', () => {
  it('is on the page until the person says they have it, then nowhere in its state', () => {
    const issued = after({ type: 'sent' }, { type: 'issued', issued: ISSUED });
    expect(issued).toMatchObject({ busy: false, issued: ISSUED, copied: null, saved: null });
    const gone = healthUiReducer(issued, { type: 'dismissed' });
    expect(gone.issued).toBeNull();
    expect(JSON.stringify(gone)).not.toContain(ISSUED.token);
  });

  it('copying says which was copied', () => {
    const state = after({ type: 'issued', issued: ISSUED }, { type: 'copied', what: 'token' });
    expect(state.copied).toBe('token');
    expect(healthUiReducer(state, { type: 'copied', what: 'example' }).copied).toBe('example');
  });

  it('a refusal says why and is not busy any more; the next try clears it', () => {
    const failed = after({ type: 'sent' }, { type: 'failed', error: 'Only editors issue tokens.' });
    expect(failed).toMatchObject({ busy: false, error: 'Only editors issue tokens.' });
    expect(healthUiReducer(failed, { type: 'sent' })).toMatchObject({ busy: true, error: null });
  });

  it('taking the token away leaves nothing behind', () => {
    const state = after(
      { type: 'issued', issued: ISSUED },
      { type: 'copied', what: 'token' },
      { type: 'revoked' }
    );
    expect(state).toEqual(initialHealthUi);
  });
});

describe('saving it for the environment’s pipeline', () => {
  it('sends the address as a plain variable and the token as a secret, in the environment’s set', () => {
    expect(variablesRequest(ISSUED)).toEqual({
      scope: 'environment',
      environment: 'dev',
      set: [
        { key: 'RENKEI_HEALTH_URL', value: ISSUED.url, secured: false },
        { key: 'RENKEI_HEALTH_TOKEN', value: ISSUED.token, secured: true },
      ],
      remove: [],
    });
  });

  it('says what was saved, and when the host’s environment was made for it', () => {
    const issued = after({ type: 'issued', issued: ISSUED }, { type: 'sent' });
    expect(
      healthUiReducer(issued, { type: 'variablesSaved', environmentCreated: false, errors: [] })
    ).toMatchObject({
      busy: false,
      saved: 'Saved as RENKEI_HEALTH_URL and the secret RENKEI_HEALTH_TOKEN for dev.',
    });
    expect(
      healthUiReducer(issued, { type: 'variablesSaved', environmentCreated: true, errors: [] })
        .saved
    ).toBe(
      'Saved as RENKEI_HEALTH_URL and the secret RENKEI_HEALTH_TOKEN for dev. The deployment environment was made on the host.'
    );
  });

  it('what the host refused is said, and nothing reads as saved', () => {
    const state = healthUiReducer(after({ type: 'issued', issued: ISSUED }, { type: 'sent' }), {
      type: 'variablesSaved',
      environmentCreated: false,
      errors: ['RENKEI_HEALTH_TOKEN: GitHub refused it.'],
    });
    expect(state).toMatchObject({
      busy: false,
      saved: null,
      error: 'Not saved: RENKEI_HEALTH_TOKEN: GitHub refused it.',
    });
  });
});

describe('a check-in, as a command', () => {
  it('posts to the address, with the token read from its variable', () => {
    const command = checkInExample(ISSUED);
    expect(command).toContain('curl -sS -X POST "https://renkei.example/api/health/check-in"');
    expect(command).toContain('-H "Authorization: Bearer $RENKEI_HEALTH_TOKEN"');
    expect(command).toContain('"status":"healthy"');
    expect(command).toContain('"nextCheckInSeconds":300');
    expect(command).toContain('"sentAt"');
    expect(command).not.toContain(ISSUED.token);
  });

  it('can carry the token itself, for trying it once', () => {
    expect(checkInExample(ISSUED, ISSUED.token)).toContain(
      `-H "Authorization: Bearer ${ISSUED.token}"`
    );
  });
});

describe('the questions asked first', () => {
  it('a new token stops the one in use', () => {
    expect(replaceQuestion('production')).toBe(
      'Issue a new token for production? The one in use stops working at once, so the application must be given the new one.'
    );
  });

  it('stopping check-ins takes the token and the health away', () => {
    expect(revokeQuestion('dev')).toBe(
      'Stop taking check-ins for dev? Its token stops working and its health stops showing.'
    );
  });
});
