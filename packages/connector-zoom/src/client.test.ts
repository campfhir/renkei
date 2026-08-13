import { ZoomClient, encodeZoomMeetingId } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('encodeZoomMeetingId', () => {
  it('double-encodes uuids that start with a slash', () => {
    expect(encodeZoomMeetingId('/abc==')).toBe('%252Fabc%253D%253D');
  });

  it('double-encodes uuids that contain a double slash', () => {
    expect(encodeZoomMeetingId('ab//cd')).toBe('ab%252F%252Fcd');
  });

  it('passes plain numeric meeting ids through untouched', () => {
    expect(encodeZoomMeetingId('86049284440')).toBe('86049284440');
  });

  it('single-encodes ordinary uuids', () => {
    expect(encodeZoomMeetingId('abc123==')).toBe('abc123%3D%3D');
  });
});

describe('ZoomClient.getMeetingTranscript', () => {
  it('returns the download url and hits the double-encoded path', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { download_url: 'https://zoom.us/rec/download/x' }));

    const result = await new ZoomClient('token').getMeetingTranscript('/abc==');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.downloadUrl).toBe('https://zoom.us/rec/download/x');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.zoom.us/v2/meetings/%252Fabc%253D%253D/transcript',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      })
    );
  });

  it('reports 404 as NOT_FOUND — transcripts lag or never exist', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(404, { code: 3001 }));

    const result = await new ZoomClient('token').getMeetingTranscript('86049284440');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('NOT_FOUND');
  });

  it('reports other failures as ZOOM_API_ERROR', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(500, {}));

    const result = await new ZoomClient('token').getMeetingTranscript('86049284440');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('ZOOM_API_ERROR');
  });

  it('reports a response without a download url as ZOOM_API_ERROR', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {}));

    const result = await new ZoomClient('token').getMeetingTranscript('86049284440');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('ZOOM_API_ERROR');
  });
});

describe('ZoomClient.downloadFromUrl', () => {
  it('returns the body text, authorized with the Bearer token', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('WEBVTT\n', { status: 200 }));

    const result = await new ZoomClient('token').downloadFromUrl('https://zoom.us/rec/dl/x');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toBe('WEBVTT\n');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://zoom.us/rec/dl/x',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      })
    );
  });

  it('reports non-2xx and network failures as ZOOM_API_ERROR', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    const denied = await new ZoomClient('token').downloadFromUrl('https://zoom.us/rec/dl/x');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.err.type).toBe('ZOOM_API_ERROR');

    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const down = await new ZoomClient('token').downloadFromUrl('https://zoom.us/rec/dl/x');
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.err.type).toBe('ZOOM_API_ERROR');
  });
});

describe('ZoomClient.getMeetingSummary', () => {
  it('returns the summary payload as-is', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { summary_overview: 'We met.' }));

    const result = await new ZoomClient('token').getMeetingSummary('86049284440');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toEqual({ summary_overview: 'We met.' });
  });

  it('reports 404 as NOT_FOUND — summaries are optional and lag too', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(404, {}));

    const result = await new ZoomClient('token').getMeetingSummary('86049284440');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('NOT_FOUND');
  });
});

describe('ZoomClient.getMe', () => {
  it('reads the identity fields, composing a display name when needed', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        id: 'u1',
        email: 'host@example.com',
        first_name: 'Ada',
        last_name: 'Lovelace',
        account_id: 'acct-1',
      })
    );

    const result = await new ZoomClient('token').getMe();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val).toEqual({
        id: 'u1',
        email: 'host@example.com',
        displayName: 'Ada Lovelace',
        accountId: 'acct-1',
      });
    }
  });

  it('fails when the response is missing id or email', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { id: 'u1' }));

    const result = await new ZoomClient('token').getMe();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('ZOOM_API_ERROR');
  });
});
