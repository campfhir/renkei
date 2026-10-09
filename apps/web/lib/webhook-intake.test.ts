import { NextRequest } from 'next/server';
import { resetInboundLimits } from './inbound-rate-limit';
import {
  GITHUB_SIGNATURE_SHAPE,
  WEBEX_SIGNATURE_SHAPE,
  WEBHOOK_LIMITS,
  WEBHOOK_MAX_BODY_BYTES,
  ZOOM_SIGNATURE_SHAPE,
  ZOOM_TIMESTAMP_SHAPE,
  checkWebhookLimit,
  hasSignatureShape,
  readWebhookBody,
} from './webhook-intake';
describe('readWebhookBody', () => {
  it('returns the body text when it is under the cap', async () => {
    const request = new NextRequest('http://localhost/api/webhooks/x', {
      method: 'POST',
      body: '{"hello":"world"}',
    });
    const result = await readWebhookBody(request);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toBe('{"hello":"world"}');
  });

  it('refuses on a declared Content-Length over the cap before reading a byte', async () => {
    const request = new NextRequest('http://localhost/api/webhooks/x', {
      method: 'POST',
      headers: { 'content-length': String(WEBHOOK_MAX_BODY_BYTES + 1) },
      body: 'small',
    });
    const result = await readWebhookBody(request);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.err.type).toBe('TOO_LARGE');
    // Nothing was consumed: the stream is still readable.
    expect(request.bodyUsed).toBe(false);
  });

  it('refuses a body that grows past the cap even when the header understates it', async () => {
    const chunk = new Uint8Array(1024).fill(65);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 20) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const request = new NextRequest('http://localhost/api/webhooks/x', {
      method: 'POST',
      headers: { 'content-length': '10' },
      body: stream,
      // undici needs duplex for a streaming body.
      duplex: 'half',
    });
    const result = await readWebhookBody(request, 4 * 1024);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.err.type).toBe('TOO_LARGE');
    // Abandoned early: well short of the twenty chunks on offer.
    expect(sent).toBeLessThan(20);
  });
});

describe('signature shapes', () => {
  it("recognises each provider's shape and nothing else", () => {
    const hex64 = 'a'.repeat(64);
    expect(hasSignatureShape(`sha256=${hex64}`, GITHUB_SIGNATURE_SHAPE)).toBe(true);
    expect(hasSignatureShape(`v0=${hex64}`, ZOOM_SIGNATURE_SHAPE)).toBe(true);
    expect(hasSignatureShape('b'.repeat(40), WEBEX_SIGNATURE_SHAPE)).toBe(true);
    expect(hasSignatureShape('1700000000', ZOOM_TIMESTAMP_SHAPE)).toBe(true);

    expect(hasSignatureShape(null, GITHUB_SIGNATURE_SHAPE)).toBe(false);
    expect(hasSignatureShape('', GITHUB_SIGNATURE_SHAPE)).toBe(false);
    expect(hasSignatureShape(hex64, GITHUB_SIGNATURE_SHAPE)).toBe(false);
    expect(hasSignatureShape('sha256=nothex', GITHUB_SIGNATURE_SHAPE)).toBe(false);
    expect(hasSignatureShape(`v1=${hex64}`, ZOOM_SIGNATURE_SHAPE)).toBe(false);
    expect(hasSignatureShape('abc', ZOOM_TIMESTAMP_SHAPE)).toBe(false);
    expect(hasSignatureShape('z'.repeat(40), WEBEX_SIGNATURE_SHAPE)).toBe(false);
  });
});

describe('checkWebhookLimit', () => {
  beforeEach(() => resetInboundLimits());

  it('keys the budget by provider', () => {
    const request = new NextRequest('http://localhost/api/webhooks/github/x', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    for (let i = 0; i < WEBHOOK_LIMITS.perClient.limit; i += 1) {
      expect(checkWebhookLimit('github', request).allowed).toBe(true);
    }
    expect(checkWebhookLimit('github', request).allowed).toBe(false);
    // Another provider's budget is untouched.
    expect(checkWebhookLimit('zoom', request).allowed).toBe(true);
  });
});
