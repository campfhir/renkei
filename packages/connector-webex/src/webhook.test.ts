import { createHmac } from 'node:crypto';
import { parseWebhookPayload, verifyWebexSignature, WEBEX_MESSAGE_CREATED } from './webhook';

function sign(body: string, secret: string): string {
  return createHmac('sha1', secret).update(body, 'utf8').digest('hex');
}

describe('verifyWebexSignature', () => {
  const body = JSON.stringify({ resource: 'messages', event: 'created', data: { id: 'm1' } });

  it('accepts the correct HMAC-SHA1 of the raw body', () => {
    expect(verifyWebexSignature(body, sign(body, 's3cret'), 's3cret')).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyWebexSignature(body, sign(body, 'other'), 's3cret')).toBe(false);
  });

  it('rejects when the body was tampered with', () => {
    expect(verifyWebexSignature(body + ' ', sign(body, 's3cret'), 's3cret')).toBe(false);
  });

  it('rejects empty signatures and secrets outright', () => {
    expect(verifyWebexSignature(body, '', 's3cret')).toBe(false);
    expect(verifyWebexSignature(body, sign(body, 's3cret'), '')).toBe(false);
  });
});

describe('parseWebhookPayload', () => {
  it('extracts the routing fields from a message webhook', () => {
    const result = parseWebhookPayload({
      resource: 'messages',
      event: 'created',
      data: { id: 'm1', roomId: 'r1', personId: 'p1', personEmail: 'sam@example.com' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.type).toBe(WEBEX_MESSAGE_CREATED);
      expect(result.val.dataId).toBe('m1');
      expect(result.val.roomId).toBe('r1');
      expect(result.val.personEmail).toBe('sam@example.com');
    }
  });

  it('rejects bodies missing resource, event, or data id', () => {
    expect(parseWebhookPayload(null).ok).toBe(false);
    expect(parseWebhookPayload({ resource: 'messages' }).ok).toBe(false);
    expect(parseWebhookPayload({ resource: 'messages', event: 'created', data: {} }).ok).toBe(
      false
    );
  });
});
