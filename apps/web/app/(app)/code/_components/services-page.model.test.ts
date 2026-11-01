/**
 * The Services page's behaviour (services-page.model.ts), as a person
 * using it would describe it. The browser spec (code-services-page.spec.ts)
 * keeps the card and page rendering what the sandbox stand-in answers, one
 * start pressed through to the worker, the tail following as the worker
 * writes, a stop, and the phone width.
 */

import type { WireService, WireServiceLogEntry } from '@renkei/sandbox-client';
import type { ServicesView } from '@/lib/code/services';
import {
  canStart,
  clockOf,
  emptyTailText,
  EMPTY_START,
  envPrefix,
  imageSuggestion,
  initialServices,
  initialTail,
  nextCursor,
  polls,
  runningPill,
  serviceReachable,
  servicesReducer,
  serviceStatusPill,
  showsServiceName,
  shownEntries,
  startRequest,
  stopQuestion,
  TAIL_KEEP,
  tailQuery,
  tailReducer,
  toneIndex,
  variablesSet,
  type ServicesAction,
  type ServicesState,
  type TailAction,
  type TailState,
} from './services-page.model';

const service = (name: string, more: Partial<WireService> = {}): WireService => ({
  id: `svc-${name}`,
  name,
  image: 'docker.io/library/postgres:16',
  status: 'running',
  error: null,
  host: '172.20.0.5',
  ports: [5432],
  exportNames: ['DATABASE_URL'],
  createdAt: '2026-11-01T00:00:00Z',
  lastUsedAt: '2026-11-01T00:00:00Z',
  expiresAt: '2026-11-02T00:00:00Z',
  ...more,
});

const VIEW: ServicesView = { enabled: true, services: [], allowed: ['docker.io/library/postgres'] };

const run = (actions: ServicesAction[], from: ServicesState = initialServices) =>
  actions.reduce(servicesReducer, from);

const opened = () => run([{ type: 'loaded', view: VIEW }]);

describe('the page', () => {
  it('knows nothing until the worker answers, and shows a failed read', () => {
    expect(initialServices.view).toBeNull();
    const failed = run([{ type: 'loadFailed', error: 'The sandbox worker is unreachable.' }]);
    expect(failed.loadError).toBe('The sandbox worker is unreachable.');
    expect(run([{ type: 'loaded', view: VIEW }], failed).loadError).toBeNull();
  });

  it('heads the page with how many are running, or None running', () => {
    expect(runningPill([])).toEqual({ tone: 'gray', label: 'None running' });
    expect(runningPill([service('db'), service('cache', { status: 'failed' })])).toEqual({
      tone: 'green',
      label: '1 running',
    });
  });
});

describe('starting a service', () => {
  it('opens on a Postgres a test suite can use as it is', () => {
    expect(run([{ type: 'startOpened' }], opened()).draft).toEqual(EMPTY_START);
    expect(EMPTY_START.name).toBe('db');
  });

  it('needs a name and an image, and nothing in flight', () => {
    const open = run([{ type: 'startOpened' }], opened());
    expect(canStart(open)).toBe(true);
    expect(canStart(run([{ type: 'draftChanged', field: 'name', value: ' ' }], open))).toBe(false);
    expect(canStart(run([{ type: 'draftChanged', field: 'image', value: '' }], open))).toBe(false);
    expect(canStart(run([{ type: 'sent' }], open))).toBe(false);
  });

  it('sends the name and image trimmed, the variables and exports as typed', () => {
    const open = run(
      [
        { type: 'startOpened' },
        { type: 'draftChanged', field: 'name', value: ' cache ' },
        { type: 'draftChanged', field: 'image', value: ' redis:7 ' },
        { type: 'draftChanged', field: 'env', value: ' A=1\n' },
      ],
      opened()
    );
    expect(startRequest(open.draft!)).toEqual({
      name: 'cache',
      image: 'redis:7',
      env: ' A=1\n',
      exports: EMPTY_START.exports,
    });
  });

  it('a started service closes the form and is named, as the worker calls it', () => {
    const started = run(
      [{ type: 'startOpened' }, { type: 'sent' }, { type: 'startDone', name: 'db' }],
      opened()
    );
    expect(started).toMatchObject({ draft: null, started: 'db', busy: false });
    // Without a name back, the one typed.
    expect(
      run([{ type: 'startOpened' }, { type: 'sent' }, { type: 'startDone', name: null }], opened())
        .started
    ).toBe('db');
    // The next change takes the line away.
    expect(run([{ type: 'sent' }], started).started).toBeNull();
  });

  it('a refusal keeps the form as typed and names why', () => {
    const refused = run(
      [
        { type: 'startOpened' },
        { type: 'draftChanged', field: 'image', value: 'bitnami/redis:7' },
        { type: 'sent' },
        { type: 'failed', error: 'bitnami/redis:7 is not an image this organization allows.' },
      ],
      opened()
    );
    expect(refused.draft?.image).toBe('bitnami/redis:7');
    expect(refused.error).toMatch(/not an image this organization allows/);
    expect(run([{ type: 'draftCancelled' }], refused).draft).toBeNull();
  });

  it('suggests an allowed namespace with its slash, so the image can be typed after it', () => {
    expect(imageSuggestion('acme.azurecr.io/platform/*')).toBe('acme.azurecr.io/platform/');
    expect(imageSuggestion('docker.io/library/postgres')).toBe('docker.io/library/postgres');
  });
});

describe('a service in the list', () => {
  it('a running one gives its address and every variable it sets for each command', () => {
    expect(serviceReachable(service('db'))).toBe(true);
    expect(variablesSet(service('db'))).toEqual([
      'SERVICE_DB_HOST',
      'SERVICE_DB_PORT',
      'DATABASE_URL',
    ]);
    expect(variablesSet(service('my-cache', { ports: [], exportNames: [] }))).toEqual([
      'SERVICE_MY_CACHE_HOST',
    ]);
    expect(envPrefix('my-cache')).toBe('SERVICE_MY_CACHE');
  });

  it('one not running, or without an address, gives its error instead', () => {
    expect(serviceReachable(service('db', { status: 'failed' }))).toBe(false);
    expect(serviceReachable(service('db', { host: null }))).toBe(false);
  });

  it('pills its status', () => {
    expect(serviceStatusPill('running')).toEqual({ tone: 'green', label: 'Running' });
    expect(serviceStatusPill('starting')).toEqual({ tone: 'blue', label: 'Starting' });
    expect(serviceStatusPill('failed')).toEqual({ tone: 'red', label: 'Failed' });
    expect(serviceStatusPill('gone')).toEqual({ tone: 'gray', label: 'Gone' });
  });

  it('Stop asks first, saying the data goes with it', () => {
    expect(stopQuestion({ name: 'db' })).toBe(
      'Stop db? The container is removed with its data; the name is free again.'
    );
  });
});

describe('the combined tail', () => {
  const line = (service: string, at: string, text: string): WireServiceLogEntry => ({
    service,
    at,
    line: text,
  });
  const tail = (actions: TailAction[], from: TailState = initialTail) =>
    actions.reduce(tailReducer, from);
  const past = (entries: WireServiceLogEntry[], truncated = false): TailAction => ({
    type: 'read',
    since: false,
    entries,
    truncated,
    unreadable: [],
  });
  const after = (entries: WireServiceLogEntry[]): TailAction => ({
    type: 'read',
    since: true,
    entries,
    truncated: false,
    unreadable: [],
  });
  const A = line(
    'db',
    '2026-11-01T10:00:00.123456789Z',
    'database system is ready to accept connections'
  );
  const B = line('cache', '2026-11-01T10:00:01.5Z', 'Ready to accept connections tcp');
  const C = line('db', '2026-11-01T10:00:03.000Z', 'checkpoint 1');

  it('starts Reading…, following', () => {
    expect(initialTail.follow).toBe(true);
    expect(emptyTailText(initialTail, ['db'])).toBe('Reading…');
  });

  it('reads the recent past first, then asks for what came after the last line', () => {
    expect(tailQuery(null)).toBe('?lines=200');
    expect(nextCursor(null, [A, B])).toBe(B.at);
    expect(tailQuery(B.at)).toBe('?since=2026-11-01T10%3A00%3A01.5Z');
    // A read that brings nothing keeps the cursor where it was.
    expect(nextCursor(B.at, [])).toBe(B.at);
  });

  it('lines that came after are added at the end; the past read again replaces them', () => {
    const state = tail([past([A]), after([B, C])]);
    expect(state.entries).toEqual([A, B, C]);
    expect(tail([past([C])], state).entries).toEqual([C]);
  });

  it('keeps only the newest lines once there are too many', () => {
    const many = Array.from({ length: TAIL_KEEP + 5 }, (_, i) => line('db', `t${i}`, `l${i}`));
    const state = tail([past(many.slice(0, 10)), after(many.slice(10))]);
    expect(state.entries).toHaveLength(TAIL_KEEP);
    expect(state.entries[0]?.line).toBe('l5');
  });

  it('marks a cut start from the past read, not from what came after', () => {
    const cut = tail([past([A], true)]);
    expect(cut.truncated).toBe(true);
    expect(tail([after([B])], cut).truncated).toBe(true);
  });

  it('filtered to one service, shows only its lines and drops its name from each', () => {
    const state = tail([past([A, B, C]), { type: 'filterChanged', filter: 'db' }]);
    expect(shownEntries(state)).toEqual([A, C]);
    expect(showsServiceName(state)).toBe(false);
    expect(showsServiceName(tail([{ type: 'filterChanged', filter: '' }], state))).toBe(true);
  });

  it('Clear empties the screen and says nothing has come from the filtered service yet', () => {
    const cleared = tail([
      past([A, B]),
      { type: 'filterChanged', filter: 'db' },
      { type: 'cleared' },
    ]);
    expect(cleared.entries).toEqual([]);
    expect(emptyTailText(cleared, ['db', 'cache'])).toBe('(nothing from db yet)');
    expect(emptyTailText(tail([{ type: 'filterChanged', filter: '' }], cleared), ['db'])).toBe(
      '(nothing yet)'
    );
    expect(emptyTailText(cleared, [])).toBe('(no services)');
  });

  it('asks again only while following with something to follow', () => {
    expect(polls(initialTail, ['db'])).toBe(true);
    expect(polls(initialTail, [])).toBe(false);
    expect(polls(tail([{ type: 'followChanged', follow: false }]), ['db'])).toBe(false);
  });

  it('a failed read says why and keeps the lines; the next good one clears it', () => {
    const failed = tail([past([A]), { type: 'readFailed', error: 'The logs could not be read.' }]);
    expect(failed.entries).toEqual([A]);
    expect(failed.error).toBe('The logs could not be read.');
    expect(tail([after([])], failed).error).toBeNull();
  });

  it('names the services whose logs could not be read, as the last read says', () => {
    const state = tail([
      { type: 'read', since: false, entries: [], truncated: false, unreadable: ['cache'] },
    ]);
    expect(state.unreadable).toEqual(['cache']);
  });

  it('stamps a line with its time of day to the millisecond', () => {
    expect(clockOf(A.at)).toBe('10:00:00.123');
    expect(clockOf(B.at)).toBe('10:00:01.5Z');
    expect(clockOf('2026-11-01T10:00:02Z')).toBe('10:00:02Z');
  });

  it('colours each service by its place in the list, round again past the last tone', () => {
    expect(toneIndex(['db', 'cache'], 'cache', 5)).toBe(1);
    expect(toneIndex(['a', 'b', 'c', 'd', 'e', 'f'], 'f', 5)).toBe(0);
    expect(toneIndex(['db'], 'gone', 5)).toBe(0);
  });
});
