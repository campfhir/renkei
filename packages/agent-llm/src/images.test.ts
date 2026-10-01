/**
 * The Images API client's promises: the request goes where the chat
 * adapter would send it (Azure's v1 route, OpenAI's, a pasted full
 * endpoint) with the credential headers that host accepts; the body asks
 * for one image in the format wanted; a base64 answer comes back as bytes;
 * and every way it can go wrong comes back as a kind the caller can speak
 * to — the safety system saying no included.
 */

import { generateImage } from './images';

const PNG_B64 = Buffer.from('not really a png').toString('base64');

function respond(status: number, body: unknown): jest.SpiedFunction<typeof fetch> {
  return jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    );
}

afterEach(() => jest.restoreAllMocks());

function lastCall(spy: jest.SpiedFunction<typeof fetch>): {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
} {
  const call = spy.mock.calls[spy.mock.calls.length - 1];
  const init = call?.[1] ?? {};
  return { url: String(call?.[0]), init, body: JSON.parse(String(init.body)) };
}

describe('generateImage', () => {
  it('returns the base64 image as bytes with its media type', async () => {
    respond(200, { data: [{ b64_json: PNG_B64 }] });
    const result = await generateImage({ apiKey: 'k', model: 'gpt-image-1' }, { prompt: 'a cat' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.mediaType).toBe('image/png');
      expect(result.val.bytes.toString()).toBe('not really a png');
    }
  });

  it('asks OpenAI for one image, in the format and quality named', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    const result = await generateImage(
      { apiKey: 'sk-1', model: 'gpt-image-1' },
      {
        prompt: 'a cat',
        size: '1024x1536',
        quality: 'low',
        outputFormat: 'jpeg',
        background: 'transparent',
      }
    );
    const call = lastCall(spy);
    expect(call.url).toBe('https://api.openai.com/v1/images/generations');
    expect(call.body).toEqual({
      model: 'gpt-image-1',
      prompt: 'a cat',
      n: 1,
      size: '1024x1536',
      quality: 'low',
      output_format: 'jpeg',
      // transparency needs a PNG, so it is not asked for on a JPEG
    });
    expect(result.ok && result.val.mediaType).toBe('image/jpeg');
    // Off Azure the key rides as both headers.
    expect(call.init.headers).toMatchObject({ authorization: 'Bearer sk-1', 'api-key': 'sk-1' });
  });

  it('asks for a transparent background on a PNG', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p', background: 'transparent' });
    expect(lastCall(spy).body.background).toBe('transparent');
  });

  it('sends Azure Bearer alone, to the v1 route, with the api-version when one is set', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    await generateImage(
      {
        apiKey: 'az-key',
        model: 'my-gpt-image-deployment',
        baseUrl: 'https://res.openai.azure.com/openai/v1/',
        apiVersion: 'preview',
      },
      { prompt: 'p' }
    );
    const call = lastCall(spy);
    expect(call.url).toBe(
      'https://res.openai.azure.com/openai/v1/images/generations?api-version=preview'
    );
    expect(call.init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer az-key',
    });
    expect(call.body.model).toBe('my-gpt-image-deployment');
  });

  it('tolerates a pasted full endpoint', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    await generateImage(
      { apiKey: 'k', model: 'm', baseUrl: 'https://gw.example/v1/images/generations' },
      { prompt: 'p' }
    );
    expect(lastCall(spy).url).toBe('https://gw.example/v1/images/generations');
  });

  it.each([
    [400, { error: { code: 'content_policy_violation', message: 'blocked' } }, 'content_filter'],
    [
      400,
      {
        error: {
          code: 'contentFilter',
          message: 'Your task failed as a result of our safety system.',
        },
      },
      'content_filter',
    ],
    [401, { error: { message: 'bad key' } }, 'auth'],
    [429, { error: { message: 'slow down' } }, 'rate_limit'],
    [404, { error: { code: 'DeploymentNotFound' } }, 'invalid_request'],
    [503, 'unavailable', 'overloaded'],
    [500, 'boom', 'provider_error'],
  ])('maps a %s answer to %s', async (status, body, kind) => {
    respond(status, body);
    const result = await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe(kind);
  });

  it('treats a filtered image reported inside a 200 as the safety system saying no', async () => {
    respond(200, {
      error: {
        code: 'contentFilter',
        message: 'Generated image was filtered as a result of our safety system.',
      },
    });
    const result = await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p' });
    expect(!result.ok && result.err.type).toBe('content_filter');
  });

  it('refuses an answer with no image, and one that is not JSON', async () => {
    respond(200, { data: [] });
    const empty = await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p' });
    expect(!empty.ok && empty.err.type).toBe('provider_error');
    respond(200, '<html>gateway</html>');
    const html = await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p' });
    expect(!html.ok && html.err.type).toBe('provider_error');
  });

  it('reports a network failure, and the caller stopping it', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const down = await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p' });
    expect(!down.ok && down.err.type).toBe('network');

    const stop = new AbortController();
    stop.abort();
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const stopped = await generateImage(
      { apiKey: 'k', model: 'm' },
      { prompt: 'p', signal: stop.signal }
    );
    expect(!stopped.ok && stopped.err.type).toBe('aborted');
  });
});
