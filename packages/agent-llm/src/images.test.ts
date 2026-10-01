/**
 * The Images API client's promises: the request goes where the chat
 * adapter would send it (Azure's v1 route, OpenAI's, a pasted full
 * endpoint) with the credential headers that host accepts; the body asks
 * for one image in the format wanted; a base64 answer comes back as bytes;
 * and every way it can go wrong comes back as a kind the caller can speak
 * to — the safety system saying no included.
 */

import { generateImage } from './images';

// Only the magic number matters here: the client sniffs the type, validation is the caller's.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('rest'),
]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG_B64 = PNG_BYTES.toString('base64');
const JPEG_B64 = JPEG_BYTES.toString('base64');

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
      expect(result.val.bytes.equals(PNG_BYTES)).toBe(true);
    }
  });

  it('asks OpenAI for one image, in the format and quality named', async () => {
    const spy = respond(200, { data: [{ b64_json: JPEG_B64 }] });
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

  it('reports the type of the bytes it got, not the format it asked for', async () => {
    respond(200, { data: [{ b64_json: PNG_B64 }] });
    const result = await generateImage(
      { apiKey: 'k', model: 'm' },
      { prompt: 'p', outputFormat: 'jpeg' }
    );
    expect(result.ok && result.val.mediaType).toBe('image/png');
  });

  it('refuses an image that is neither a PNG nor a JPEG', async () => {
    respond(200, { data: [{ b64_json: Buffer.from('RIFF....WEBP').toString('base64') }] });
    const result = await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p' });
    expect(!result.ok && result.err.type).toBe('provider_error');
  });
});

describe('generateImage — FLUX on Azure AI Foundry', () => {
  const flux = {
    apiKey: 'az-key',
    model: 'FLUX.2-flex',
    surface: 'flux' as const,
    baseUrl: 'https://res.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-flex',
    apiVersion: 'preview',
  };

  it('posts to the model’s own provider URL with width and height, Bearer alone', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    const result = await generateImage(flux, {
      prompt: 'A photograph of a red fox in an autumn forest',
      size: '1536x1024',
      // FLUX has no quality or background knobs (not sent); the format is.
      quality: 'high',
      outputFormat: 'jpeg',
      background: 'transparent',
    });
    const call = lastCall(spy);
    expect(call.url).toBe(
      'https://res.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-flex?api-version=preview'
    );
    expect(call.body).toEqual({
      prompt: 'A photograph of a red fox in an autumn forest',
      model: 'FLUX.2-flex',
      width: 1536,
      height: 1024,
      num_images: 1,
      output_format: 'jpeg',
    });
    expect(call.init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer az-key',
    });
    expect(result.ok && result.val.mediaType).toBe('image/png');
  });

  it('draws 1024x1024 for auto or no size', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    for (const size of [undefined, 'auto']) {
      await generateImage(flux, { prompt: 'p', ...(size ? { size } : {}) });
      expect(lastCall(spy).body).toMatchObject({ width: 1024, height: 1024 });
    }
  });

  it('keeps a query string already on the endpoint, and omits an unset api-version', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    await generateImage({ ...flux, baseUrl: `${flux.baseUrl}?x=1` }, { prompt: 'p' });
    expect(lastCall(spy).url).toBe(`${flux.baseUrl}?x=1&api-version=preview`);
    await generateImage({ ...flux, apiVersion: null }, { prompt: 'p' });
    expect(lastCall(spy).url).toBe(flux.baseUrl);
  });

  it('refuses a FLUX model with no endpoint, without calling anything', async () => {
    const spy = respond(200, {});
    const result = await generateImage({ ...flux, baseUrl: null }, { prompt: 'p' });
    expect(!result.ok && result.err.type).toBe('invalid_request');
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps its failures the same way', async () => {
    respond(400, { error: { code: 'content_policy_violation' } });
    const filtered = await generateImage(flux, { prompt: 'p' });
    expect(!filtered.ok && filtered.err.type).toBe('content_filter');
    respond(429, 'slow down');
    const limited = await generateImage(flux, { prompt: 'p' });
    expect(!limited.ok && limited.err.type).toBe('rate_limit');
  });
});

describe('generateImage — usage', () => {
  it('returns the tokens gpt-image bills, and null when the provider says nothing', async () => {
    respond(200, {
      data: [{ b64_json: PNG_B64 }],
      usage: { input_tokens: 61, output_tokens: 4160, total_tokens: 4221 },
    });
    const billed = await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p' });
    expect(billed.ok && billed.val.usage).toEqual({ inputTokens: 61, outputTokens: 4160 });

    respond(200, { data: [{ b64_json: PNG_B64 }] });
    const silent = await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p' });
    expect(silent.ok && silent.val.usage).toBeNull();

    respond(200, { data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 'many' } });
    const junk = await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p' });
    expect(junk.ok && junk.val.usage).toBeNull();
  });
});

describe('generateImage — editing a source image', () => {
  const source = {
    bytes: PNG_BYTES,
    mediaType: 'image/png' as const,
    filename: 'cute_polar_bear.png',
  };

  function editCall(spy: jest.SpiedFunction<typeof fetch>) {
    const call = spy.mock.calls[spy.mock.calls.length - 1];
    const init = call?.[1] ?? {};
    const form = init.body;
    if (!(form instanceof FormData)) throw new Error('expected a multipart body');
    return { url: String(call?.[0]), init, form };
  }

  it('posts multipart to /images/edits with the picture as image, and no JSON content type', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    const result = await generateImage(
      { apiKey: 'sk-1', model: 'gpt-image-1' },
      {
        prompt: 'make it bluer',
        size: '1024x1536',
        quality: 'low',
        outputFormat: 'png',
        image: source,
      }
    );
    expect(result.ok).toBe(true);
    const { url, init, form } = editCall(spy);
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(form).toBeInstanceOf(FormData);
    // The person's words, untouched, and the options asked for.
    expect(form.get('prompt')).toBe('make it bluer');
    expect(form.get('model')).toBe('gpt-image-1');
    expect(form.get('n')).toBe('1');
    expect(form.get('size')).toBe('1024x1536');
    expect(form.get('quality')).toBe('low');
    expect(form.get('output_format')).toBe('png');
    // The picture is a file part carrying its name, type and exact bytes.
    const file = form.get('image');
    if (!(file instanceof File)) throw new Error('expected a file part');
    expect(file.name).toBe('cute_polar_bear.png');
    expect(file.type).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
    // fetch sets the multipart boundary itself; a JSON type would break it.
    expect(init.headers).not.toHaveProperty('content-type');
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk-1', 'api-key': 'sk-1' });
  });

  it('edits on Azure with Bearer alone, keeping the api-version', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    await generateImage(
      {
        apiKey: 'az-key',
        model: 'my-deployment',
        baseUrl: 'https://res.openai.azure.com/openai/v1/',
        apiVersion: 'preview',
      },
      { prompt: 'p', image: source }
    );
    const { url, init } = editCall(spy);
    expect(url).toBe('https://res.openai.azure.com/openai/v1/images/edits?api-version=preview');
    expect(init.headers).toEqual({ authorization: 'Bearer az-key' });
  });

  it('tolerates a pasted generations or edits endpoint', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    for (const tail of ['images/generations', 'images/edits']) {
      await generateImage(
        { apiKey: 'k', model: 'm', baseUrl: `https://gw.example/v1/${tail}` },
        { prompt: 'p', image: source }
      );
      expect(editCall(spy).url).toBe('https://gw.example/v1/images/edits');
    }
  });

  it('still posts JSON to /images/generations when there is no source image', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p' });
    const { url, init } = lastCall(spy);
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(typeof init.body).toBe('string');
  });

  it('sends FLUX the picture as base64 input_image in the JSON body', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    await generateImage(
      {
        apiKey: 'az-key',
        model: 'FLUX.2-flex',
        surface: 'flux',
        baseUrl: 'https://res.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-flex',
        apiVersion: 'preview',
      },
      { prompt: 'make it bluer', size: '1536x1024', image: source }
    );
    const call = lastCall(spy);
    expect(call.url).toContain('/providers/blackforestlabs/v1/flux-2-flex?api-version=preview');
    expect(call.body).toEqual({
      prompt: 'make it bluer',
      model: 'FLUX.2-flex',
      width: 1536,
      height: 1024,
      num_images: 1,
      output_format: 'png',
      input_image: PNG_B64,
    });
    expect(call.init.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('sends FLUX no input_image for a plain generation', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    await generateImage(
      {
        apiKey: 'k',
        model: 'FLUX.2-flex',
        surface: 'flux',
        baseUrl: 'https://res.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-flex',
      },
      { prompt: 'p' }
    );
    expect(lastCall(spy).body).not.toHaveProperty('input_image');
  });

  it('maps an edit the model cannot do like any other rejected request', async () => {
    respond(400, { error: { message: 'This model does not support image editing' } });
    const result = await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p', image: source });
    expect(!result.ok && result.err.type).toBe('invalid_request');
  });
});

describe('generateImage — Azure FLUX routes', () => {
  it('reads the native provider route’s answer: b64_json, a seed, and prompt/completion tokens', async () => {
    respond(200, {
      data: [{ b64_json: PNG_B64, seed: 42598132 }],
      usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
    });
    const result = await generateImage(
      {
        apiKey: 'k',
        model: 'FLUX.2-pro',
        surface: 'flux',
        baseUrl: 'https://res.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-pro',
      },
      { prompt: 'p' }
    );
    expect(result.ok && result.val.bytes.equals(PNG_BYTES)).toBe(true);
    expect(result.ok && result.val.usage).toEqual({ inputTokens: 12, outputTokens: 0 });
  });

  it('reads the OpenAI-compatible route’s answer, revised_prompt and all', async () => {
    respond(200, {
      created: 1718000000,
      data: [{ b64_json: PNG_B64, revised_prompt: 'A highly detailed photograph of a red fox…' }],
    });
    const result = await generateImage(
      { apiKey: 'k', model: 'FLUX.1-Kontext-pro' },
      { prompt: 'p' }
    );
    expect(result.ok && result.val.mediaType).toBe('image/png');
    expect(result.ok && result.val.usage).toBeNull();
  });

  it('treats Azure’s moderation block as the safety system saying no, not a bad request', async () => {
    respond(400, {
      error: {
        code: '400',
        message: 'The response was blocked due to content moderation policies.',
        target: 'prompt',
        details: [],
      },
    });
    const result = await generateImage({ apiKey: 'k', model: 'm' }, { prompt: 'p' });
    expect(!result.ok && result.err.type).toBe('content_filter');
  });
});

describe('generateImage — an answer that is a link', () => {
  const flux = {
    apiKey: 'k',
    model: 'FLUX.2-pro',
    surface: 'flux' as const,
    baseUrl: 'https://r.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-pro',
  };

  function twoCalls(link: string) {
    return jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ url: link }] }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(PNG_BYTES, { status: 200 }));
  }

  it('downloads a public https link without credentials or redirects', async () => {
    const spy = twoCalls('https://cdn.example.com/out.png');
    const result = await generateImage(flux, { prompt: 'fox' });
    expect(result.ok && result.val.bytes.equals(PNG_BYTES)).toBe(true);
    const init = spy.mock.calls[1]?.[1];
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toBeUndefined();
  });

  it.each([
    'http://cdn.example.com/out.png',
    'https://127.0.0.1/out.png',
    'https://localhost/out.png',
    'https://[::1]/out.png',
    'https://metadata.internal/out.png',
    'not a url',
  ])('refuses %s without fetching it', async (link) => {
    const spy = twoCalls(link);
    const result = await generateImage(flux, { prompt: 'fox' });
    expect(result.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('generateImage — BFL’s own asynchronous API', () => {
  const bfl = {
    apiKey: 'bfl-key',
    model: 'FLUX.2-flex',
    surface: 'flux' as const,
    baseUrl: 'https://api.bfl.ai/v1/flux-2-flex',
    fluxOptions: { steps: 30, guidance: 4, safetyTolerance: 1, promptUpsampling: false },
  };

  it('submits with x-key, polls until Ready, downloads the sample, and reports the cost', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'abc',
            polling_url: 'https://api.eu1.bfl.ai/v1/get_result?id=abc',
            cost: 7.5,
            input_mp: 0,
            output_mp: 1.05,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'Ready', result: { sample: 'https://delivery.bfl.ai/x.png' } })
        )
      )
      .mockResolvedValueOnce(new Response(PNG_BYTES, { status: 200 }));
    const result = await generateImage(bfl, { prompt: 'fox', size: '1024x768' });
    expect(result.ok && result.val.bytes.equals(PNG_BYTES)).toBe(true);
    expect(result.ok && result.val.cost).toEqual({ credits: 7.5, inputMp: 0, outputMp: 1.05 });
    const submit = lastCallOf(spy, 0);
    expect(submit.headers).toEqual({ 'content-type': 'application/json', 'x-key': 'bfl-key' });
    expect(JSON.parse(String(submit.body))).toEqual({
      prompt: 'fox',
      width: 1024,
      height: 768,
      output_format: 'png',
      steps: 30,
      guidance: 4,
      safety_tolerance: 1,
      prompt_upsampling: false,
    });
    expect(spy.mock.calls[1]?.[1]?.headers).toEqual({ 'x-key': 'bfl-key' });
    // The signed download carries no credentials.
    expect(spy.mock.calls[2]?.[1]?.headers).toBeUndefined();
  });

  it('reads a moderated task as the safety system saying no', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'a', polling_url: 'https://api.bfl.ai/v1/get_result?id=a' })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'Content Moderated' })));
    const result = await generateImage(bfl, { prompt: 'x' });
    expect(!result.ok && result.err.type).toBe('content_filter');
  });

  it('never sends the key to a polling URL on another host', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'a', polling_url: 'https://evil.example.com/poll' }))
      );
    const result = await generateImage(bfl, { prompt: 'x' });
    expect(result.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('drops advanced options outside BFL’s documented ranges', async () => {
    const spy = respond(200, { data: [{ b64_json: PNG_B64 }] });
    await generateImage(
      { ...bfl, fluxOptions: { steps: 99, guidance: 0.1, safetyTolerance: 9 } },
      { prompt: 'x' }
    );
    expect(JSON.parse(String(lastCallOf(spy, 0).body))).toEqual({
      prompt: 'x',
      width: 1024,
      height: 1024,
      output_format: 'png',
    });
  });
});

function lastCallOf(spy: jest.SpiedFunction<typeof fetch>, index: number): RequestInit {
  return spy.mock.calls[index]?.[1] ?? {};
}
