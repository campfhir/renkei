/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * callMistralOcr's own contract: the request carries the document as a
 * base64 data: URL under the field the doc-type calls for, a non-2xx or
 * unreachable endpoint maps to a typed error rather than throwing, and a
 * malformed response body (missing pages, a page missing index/markdown)
 * is refused rather than silently accepted.
 */

import { callMistralOcr } from './client';
import type { MistralOcrConfig } from './types';

const CONFIG: MistralOcrConfig = {
  endpoint: 'https://example.services.ai.azure.com/ocr',
  model: 'mistral-ocr-4-0',
  apiKey: 'test-key',
};

const INPUT = { bytes: new Uint8Array([1, 2, 3]), filename: 'report.pdf', contentType: 'application/pdf' };

describe('callMistralOcr', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends the document as a document_url data: URL for a PDF, with the bearer key', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ pages: [{ index: 0, markdown: 'hello' }] }), { status: 200 })
    );

    const result = await callMistralOcr(CONFIG, INPUT);

    expect(result.ok).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CONFIG.endpoint);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    expect((init.headers as Record<string, string>)['extra-parameters']).toBe('pass-through');
    const body = JSON.parse(String(init.body)) as { model: string; document: { type: string; document_url: string } };
    expect(body.model).toBe('mistral-ocr-4-0');
    expect(body.document.type).toBe('document_url');
    expect(body.document.document_url).toMatch(/^data:application\/pdf;base64,/);
  });

  it('sends an image_url for a non-pdf content type', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ pages: [] }), { status: 200 }));

    await callMistralOcr(CONFIG, { ...INPUT, filename: 'page.tif', contentType: 'image/tiff' });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { document: { type: string } };
    expect(body.document.type).toBe('image_url');
  });

  it('parses pages and usage_info on success', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          pages: [
            { index: 0, markdown: 'page one' },
            { index: 1, markdown: 'page two' },
          ],
          usage_info: { pages_processed: 2 },
        }),
        { status: 200 }
      )
    );

    const result = await callMistralOcr(CONFIG, INPUT);

    if (!result.ok) throw new Error('expected success');
    expect(result.val.pages).toEqual([
      { index: 0, markdown: 'page one' },
      { index: 1, markdown: 'page two' },
    ]);
    expect(result.val.pagesProcessed).toBe(2);
  });

  it('maps a non-2xx response to a typed refused error', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad request', { status: 400 }));

    const result = await callMistralOcr(CONFIG, INPUT);

    if (result.ok) throw new Error('expected failure');
    expect(result.err).toEqual({ type: 'refused', status: 400, message: 'bad request' });
  });

  it('maps a network failure to unreachable', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await callMistralOcr(CONFIG, INPUT);

    if (result.ok) throw new Error('expected failure');
    expect(result.err).toEqual({ type: 'unreachable', message: 'ECONNREFUSED' });
  });

  it('refuses a response with no pages array', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    const result = await callMistralOcr(CONFIG, INPUT);

    if (result.ok) throw new Error('expected failure');
    expect(result.err.type).toBe('malformed');
  });

  it('refuses a page entry missing index or markdown', async () => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ pages: [{ index: 0 }] }), { status: 200 }));

    const result = await callMistralOcr(CONFIG, INPUT);

    if (result.ok) throw new Error('expected failure');
    expect(result.err.type).toBe('malformed');
  });

  describe('debug logging', () => {
    function fakeLogger() {
      return { debug: jest.fn() };
    }

    it('is silent when no logger is passed', async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ pages: [] }), { status: 200 }));

      // No throw, no logger call to assert on — just confirms the optional
      // param truly is optional.
      await callMistralOcr(CONFIG, INPUT);
    });

    it('logs the request without ever including the API key', async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ pages: [] }), { status: 200 }));
      const logger = fakeLogger();

      await callMistralOcr(CONFIG, INPUT, { logger });

      const [message, attrs] = logger.debug.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toContain('request');
      expect(attrs.endpoint).toBe(CONFIG.endpoint);
      expect(attrs.model).toBe(CONFIG.model);
      expect(attrs.documentType).toBe('document_url');
      expect(JSON.stringify(attrs)).not.toContain(CONFIG.apiKey);
    });

    it('logs the response status and a bounded body preview, even on a refusal', async () => {
      fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('x'.repeat(10_000), { status: 422 }));
      const logger = fakeLogger();

      await callMistralOcr(CONFIG, INPUT, { logger });

      const [message, attrs] = logger.debug.mock.calls[1] as [string, Record<string, unknown>];
      expect(message).toContain('response');
      expect(attrs.status).toBe(422);
      expect(attrs.ok).toBe(false);
      expect(String(attrs.bodyPreview).length).toBeLessThan(10_000);
    });

    it('logs a network failure instead of throwing past the caller', async () => {
      fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      const logger = fakeLogger();

      await callMistralOcr(CONFIG, INPUT, { logger });

      expect(logger.debug).toHaveBeenCalledTimes(2); // the request line, then the failure line
      const [, attrs] = logger.debug.mock.calls[1] as [string, Record<string, unknown>];
      expect(attrs.error).toBe('ECONNREFUSED');
    });
  });
});
