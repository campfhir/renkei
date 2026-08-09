import { createHmac } from 'node:crypto';
import {
  buildUrlValidationResponse,
  parseZoomWebhookPayload,
  urlValidationTokenOf,
  verifyZoomSignature,
} from './webhook';

const SECRET = 'zoom-secret-token';

function sign(rawBody: string, timestamp: string, secret: string): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
}

describe('verifyZoomSignature', () => {
  const body = JSON.stringify({ event: 'recording.transcript_completed', payload: {} });
  const timestamp = '1700000000';
  const now = 1700000000 * 1000;

  it('accepts the correct v0 HMAC-SHA256 within the replay window', () => {
    expect(verifyZoomSignature(body, sign(body, timestamp, SECRET), timestamp, SECRET, now)).toBe(
      true
    );
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyZoomSignature(body, sign(body, timestamp, 'other'), timestamp, SECRET, now)).toBe(
      false
    );
  });

  it('rejects when the body was tampered with', () => {
    expect(
      verifyZoomSignature(body + ' ', sign(body, timestamp, SECRET), timestamp, SECRET, now)
    ).toBe(false);
  });

  it('rejects when the timestamp was rewritten (it is part of the signed message)', () => {
    const other = '1700000060';
    expect(verifyZoomSignature(body, sign(body, timestamp, SECRET), other, SECRET, now)).toBe(
      false
    );
  });

  it('rejects deliveries outside the 5-minute replay window, either direction', () => {
    const goodSig = sign(body, timestamp, SECRET);
    const late = now + 300_001;
    const early = now - 300_001;
    const edge = now + 300_000;
    expect(verifyZoomSignature(body, goodSig, timestamp, SECRET, late)).toBe(false);
    expect(verifyZoomSignature(body, goodSig, timestamp, SECRET, early)).toBe(false);
    expect(verifyZoomSignature(body, goodSig, timestamp, SECRET, edge)).toBe(true);
  });

  it('rejects missing headers, empty secrets, and non-numeric timestamps outright', () => {
    const goodSig = sign(body, timestamp, SECRET);
    expect(verifyZoomSignature(body, null, timestamp, SECRET, now)).toBe(false);
    expect(verifyZoomSignature(body, goodSig, null, SECRET, now)).toBe(false);
    expect(verifyZoomSignature(body, goodSig, timestamp, '', now)).toBe(false);
    expect(verifyZoomSignature(body, goodSig, 'not-a-number', SECRET, now)).toBe(false);
  });
});

describe('buildUrlValidationResponse', () => {
  it('echoes the plainToken with its HMAC-SHA256 under the secret token', () => {
    const response = buildUrlValidationResponse('qgg8vlvZRS6UYooatFL8Aw', SECRET);
    expect(response.plainToken).toBe('qgg8vlvZRS6UYooatFL8Aw');
    expect(response.encryptedToken).toBe(
      createHmac('sha256', SECRET).update('qgg8vlvZRS6UYooatFL8Aw').digest('hex')
    );
  });
});

describe('parseZoomWebhookPayload', () => {
  const transcriptCompleted = {
    event: 'recording.transcript_completed',
    download_token: 'dl-token',
    payload: {
      account_id: 'acct-1',
      object: {
        uuid: '4444AAAiAAAAAiAiAiiAii==',
        id: 86049284440,
        host_id: 'host-1',
        host_email: 'Host@Example.com',
        topic: 'Weekly sync',
        start_time: '2026-08-09T10:00:00Z',
      },
    },
  };

  it('extracts the routing fields from a transcript_completed webhook', () => {
    const result = parseZoomWebhookPayload(transcriptCompleted);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.type).toBe('recording.transcript_completed');
      expect(result.val.hostId).toBe('host-1');
      expect(result.val.hostEmail).toBe('Host@Example.com');
      expect(result.val.meetingId).toBe('86049284440');
      expect(result.val.meetingUuid).toBe('4444AAAiAAAAAiAiAiiAii==');
      expect(result.val.downloadToken).toBe('dl-token');
      expect(result.val.data.topic).toBe('Weekly sync');
    }
  });

  it('keeps a string meeting id as-is', () => {
    const result = parseZoomWebhookPayload({
      event: 'meeting.ended',
      payload: { object: { id: '86049284440', uuid: 'u==' } },
    });
    if (result.ok) expect(result.val.meetingId).toBe('86049284440');
    expect(result.ok).toBe(true);
  });

  it('tolerates events without payload.object, nulling the optional fields', () => {
    const result = parseZoomWebhookPayload({ event: 'endpoint.url_validation', payload: {} });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.type).toBe('endpoint.url_validation');
      expect(result.val.hostEmail).toBeNull();
      expect(result.val.meetingId).toBeNull();
      expect(result.val.meetingUuid).toBeNull();
      expect(result.val.downloadToken).toBeNull();
      expect(result.val.data).toEqual({});
    }
  });

  it('rejects bodies that are not records or carry no event name', () => {
    expect(parseZoomWebhookPayload(null).ok).toBe(false);
    expect(parseZoomWebhookPayload('event').ok).toBe(false);
    expect(parseZoomWebhookPayload({ payload: {} }).ok).toBe(false);
    expect(parseZoomWebhookPayload({ event: '' }).ok).toBe(false);
  });
});

describe('urlValidationTokenOf', () => {
  it('reads payload.plainToken from a url_validation body', () => {
    expect(
      urlValidationTokenOf({
        event: 'endpoint.url_validation',
        payload: { plainToken: 'qgg8vlvZRS6UYooatFL8Aw' },
      })
    ).toBe('qgg8vlvZRS6UYooatFL8Aw');
  });

  it('answers null for everything else', () => {
    expect(urlValidationTokenOf(null)).toBeNull();
    expect(urlValidationTokenOf({ event: 'meeting.ended', payload: { object: {} } })).toBeNull();
    expect(urlValidationTokenOf({ payload: { plainToken: 42 } })).toBeNull();
  });
});
