/**
 * Delta rounds: initial URLs per resource kind, nextLink-following with
 * accumulation, the deltaLink handed back for the next round, and the
 * plain-text body preference sent on every page.
 */

import { initialDeltaUrl, runDeltaRound } from './delta';
import { GRAPH_BASE_URL } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('initialDeltaUrl', () => {
  it('names the inbox delta for mail', () => {
    expect(initialDeltaUrl('mail-inbox')).toBe("/me/mailFolders('inbox')/messages/delta");
  });

  it('bounds the calendar view with defaults of -30d .. +180d', () => {
    const url = initialDeltaUrl('calendar');
    expect(url.startsWith('/me/calendarView/delta?')).toBe(true);

    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    const start = new Date(query.get('startDateTime')!).getTime();
    const end = new Date(query.get('endDateTime')!).getTime();
    const day = 24 * 60 * 60 * 1000;
    expect(Math.abs(start - (Date.now() - 30 * day))).toBeLessThan(60 * 1000);
    expect(Math.abs(end - (Date.now() + 180 * day))).toBeLessThan(60 * 1000);
  });

  it('uses an explicit calendar window when given one', () => {
    const url = initialDeltaUrl('calendar', {
      windowStart: new Date('2026-01-01T00:00:00Z'),
      windowEnd: new Date('2026-02-01T00:00:00Z'),
    });
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(query.get('startDateTime')).toBe('2026-01-01T00:00:00.000Z');
    expect(query.get('endDateTime')).toBe('2026-02-01T00:00:00.000Z');
  });

  it('names the task list delta for todo, requiring the listId', () => {
    expect(initialDeltaUrl('todo', { listId: 'list-1' })).toBe('/me/todo/lists/list-1/tasks/delta');
    expect(() => initialDeltaUrl('todo')).toThrow();
  });
});

describe('runDeltaRound', () => {
  it('follows nextLinks, accumulates items, and returns the final deltaLink', async () => {
    const page2 = `${GRAPH_BASE_URL}/me/messages/delta?$skiptoken=t2`;
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(200, { value: [{ id: 'm1' }, { id: 'm2' }], '@odata.nextLink': page2 })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          value: [{ id: 'm3' }],
          '@odata.deltaLink': `${GRAPH_BASE_URL}/me/messages/delta?$deltatoken=d1`,
        })
      );

    const result = await runDeltaRound('token-1', "/me/mailFolders('inbox')/messages/delta");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.items).toEqual([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
      expect(result.val.deltaLink).toBe(`${GRAPH_BASE_URL}/me/messages/delta?$deltatoken=d1`);
    }

    // The nextLink is followed verbatim as an absolute URL.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toBe(page2);
  });

  it('sends the plain-text body preference on every page', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(200, {
          value: [],
          '@odata.nextLink': `${GRAPH_BASE_URL}/delta?$skiptoken=t2`,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { value: [], '@odata.deltaLink': `${GRAPH_BASE_URL}/delta?d=1` })
      );

    await runDeltaRound('token-1', '/me/calendarView/delta?startDateTime=a&endDateTime=b');

    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('Prefer')).toBe('outlook.body-content-type="text"');
    }
  });

  it('returns a null deltaLink when Graph never produces one', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { value: [] }));

    const result = await runDeltaRound('token-1', '/me/messages/delta');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.deltaLink).toBeNull();
  });

  it('stops at the page cap instead of looping forever', async () => {
    // A fresh Response per call — a body is single-use.
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse(200, {
        value: [{ id: 'x' }],
        '@odata.nextLink': `${GRAPH_BASE_URL}/delta?$skiptoken=again`,
      })
    );

    const result = await runDeltaRound('token-1', '/me/messages/delta');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.deltaLink).toBeNull();
      expect(result.val.items).toHaveLength(50);
    }
    expect(fetchMock).toHaveBeenCalledTimes(50);
  });

  it('propagates a page failure', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(503, {}));

    const result = await runDeltaRound('token-1', '/me/messages/delta');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('GRAPH_API_ERROR');
  });
});
