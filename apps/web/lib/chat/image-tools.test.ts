/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for fakes that never touch it */
/**
 * chat_generate_image's promises: offered only when the org has an image
 * generation model; draws from the person's own message word for word
 * (the chat model supplies no prompt), with the person's saved model when
 * the org still offers it; takes the shape as pixels or a ratio and falls
 * back to a size the model will draw; keeps what comes back only as a
 * rebuilt PNG or JPEG, counted in the ledger; and turns every failure
 * into words the model can act on.
 */

import { err, ok } from '@campfhir/safe-functions/helpers';
import type { generateImage, resolveImageModel } from '@renkei/agent-llm';
import type { LocalToolContext } from './local-tools';
import { IMAGE_TOOL, imageGenerationTool, pickImageModel } from './image-tools';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAA1BMVEX/AAAZ4gk3AAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC',
  'base64'
); // a real 2x2 PNG
const SCRIPT = Buffer.from('<script>alert(1)</script>');
const USER_TEXT = 'generate a picture of a cute polarbear';

const models = [
  { id: 'img-1', label: 'Painter', model: 'gpt-image-1' },
  { id: 'img-2', label: 'Sketcher', model: 'FLUX.2-flex' },
];

function context(extra: Partial<LocalToolContext> = {}): LocalToolContext {
  return {
    db: null as unknown as LocalToolContext['db'],
    tenantId: 't',
    subject: 'u',
    chatId: 'c',
    projectId: null,
    readOnly: false,
    userPrompt: USER_TEXT,
    ...extra,
  };
}

interface Doc {
  mediaType: string;
  dataBase64: string;
  title: string;
}
const documentsOf = (meta: Record<string, unknown>): Doc[] =>
  Array.isArray(meta.renkeiDocuments) ? (meta.renkeiDocuments as Doc[]) : [];

const resolveOk = jest.fn(async (_db: unknown, _tenant: string, id: string | null) =>
  ok({
    modelConfigId: id ?? 'img-1',
    label: 'x',
    config: { apiKey: 'k', model: 'gpt-image-1', surface: 'images' as const },
  })
) as unknown as typeof resolveImageModel;

function tool(
  generate: typeof generateImage,
  extra: { preferredModelId?: string | null; resolve?: typeof resolveImageModel } = {}
) {
  return imageGenerationTool({
    models,
    generate,
    resolve: extra.resolve ?? resolveOk,
    preferredModelId: extra.preferredModelId,
  })!;
}
const returning = (bytes: Buffer = PNG, mediaType: 'image/png' | 'image/jpeg' = 'image/png') =>
  jest.fn(async () => ok({ bytes, mediaType, usage: null })) as unknown as typeof generateImage;
const rejecting = (type: string, message = 'detail') =>
  jest.fn(async () => err(type as never, { message })) as unknown as typeof generateImage;

beforeEach(() => jest.clearAllMocks());

describe('pickImageModel', () => {
  it('is the person’s own choice while the org offers it, else the first', () => {
    expect(pickImageModel(models, 'img-2')?.id).toBe('img-2');
    expect(pickImageModel(models, 'gone')?.id).toBe('img-1');
    expect(pickImageModel(models, null)?.id).toBe('img-1');
    expect(pickImageModel(models, undefined)?.id).toBe('img-1');
    expect(pickImageModel([], 'img-1')).toBeNull();
  });
});

describe('chat_generate_image — offering', () => {
  it('is not offered when the org has no image generation model', () => {
    expect(imageGenerationTool({ models: [] })).toBeNull();
  });

  it('tells the model to use it rather than refuse, and that it writes no prompt', () => {
    const def = tool(returning()).def;
    expect(def.name).toBe(IMAGE_TOOL);
    expect(def.description).toMatch(/cannot draw pixels yourself/);
    expect(def.description).toMatch(/rather than saying it is not possible/);
    expect(def.description).toMatch(/exactly as they wrote it/);
    expect(def.description).toMatch(/automatically retried/);
    expect(def.description).toMatch(/make it bluer/);
    expect(def.description).toMatch(/sourceImage to that picture’s filename/);
  });

  it('takes no prompt and no model from the chat model — only the shape, name and look', () => {
    const properties = Object.keys(tool(returning()).def.inputSchema.properties ?? {});
    expect(properties.sort()).toEqual([
      'aspectRatio',
      'background',
      'filename',
      'quality',
      'size',
      'sourceImage',
    ]);
    expect(tool(returning()).def.inputSchema.required).toEqual([]);
  });
});

describe('chat_generate_image — the prompt is the person’s own', () => {
  it('sends their message untouched, whatever the chat model passes as input', async () => {
    const generate = returning();
    await tool(generate).execute(
      { filename: 'bear.png', prompt: 'A cute, round, fluffy baby polar bear…', size: '1024x1024' },
      context()
    );
    expect(generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prompt: USER_TEXT })
    );
  });

  it('refuses when the person typed nothing, or too much, without calling the model', async () => {
    const generate = returning();
    const empty = await tool(generate).execute(
      { filename: 'a.png' },
      context({ userPrompt: '  ' })
    );
    expect(empty.isError).toBe(true);
    expect(empty.content[0]?.text).toMatch(/no message from the person/);
    const none = await tool(generate).execute(
      { filename: 'a.png' },
      context({ userPrompt: undefined })
    );
    expect(none.isError).toBe(true);
    const long = await tool(generate).execute(
      { filename: 'a.png' },
      context({ userPrompt: 'x'.repeat(32_001) })
    );
    expect(long.isError).toBe(true);
    expect(long.content[0]?.text).toMatch(/at most 32000/);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('chat_generate_image — which model', () => {
  it('uses the person’s saved model when the org still offers it', async () => {
    await tool(returning(), { preferredModelId: 'img-2' }).execute(
      { filename: 'a.png' },
      context()
    );
    expect(resolveOk).toHaveBeenLastCalledWith(null, 't', 'img-2');
  });

  it('falls back to the first when the saved one is gone, or none is saved', async () => {
    await tool(returning(), { preferredModelId: 'retired' }).execute(
      { filename: 'a.png' },
      context()
    );
    expect(resolveOk).toHaveBeenLastCalledWith(null, 't', 'img-1');
    await tool(returning()).execute({ filename: 'a.png' }, context());
    expect(resolveOk).toHaveBeenLastCalledWith(null, 't', 'img-1');
  });

  it('says so when the chosen model cannot be used right now', async () => {
    const generate = returning();
    const gone = jest.fn(async () =>
      err('NO_MODEL' as const, { message: 'none' })
    ) as unknown as typeof resolveImageModel;
    const result = await tool(generate, { resolve: gone }).execute(
      { filename: 'a.png' },
      context()
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/"Painter" cannot be used right now/);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('chat_generate_image — making an image', () => {
  it('keeps a PNG, names its size, and counts it in the ledger', async () => {
    const recordImageUsage = jest.fn(async () => {});
    const generate = jest.fn(async () =>
      ok({
        bytes: PNG,
        mediaType: 'image/png' as const,
        usage: { inputTokens: 61, outputTokens: 4160 },
      })
    ) as unknown as typeof generateImage;
    const result = await tool(generate).execute(
      { filename: 'bear.png', size: '1024x1536', quality: 'low', background: 'transparent' },
      context({ recordImageUsage })
    );
    expect(result.isError).toBe(false);
    expect(generate).toHaveBeenCalledWith(
      { apiKey: 'k', model: 'gpt-image-1', surface: 'images' },
      {
        prompt: USER_TEXT,
        size: '1024x1536',
        quality: 'low',
        background: 'transparent',
        outputFormat: 'png',
      }
    );
    const [doc] = documentsOf(result.meta);
    expect(doc).toMatchObject({ mediaType: 'image/png', title: 'bear.png' });
    expect(Buffer.from(doc!.dataBase64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(result.meta.renkeiDocumentsShown).toBe(false);
    expect(result.content[0]?.text).toMatch(
      /Generated bear\.png with Painter \(image\/png, 2x2 px, \d+ bytes\)/
    );
    expect(recordImageUsage).toHaveBeenCalledTimes(1);
    expect(recordImageUsage).toHaveBeenCalledWith({
      surface: 'images',
      provider: 'openai',
      model: 'gpt-image-1',
      imageBytes: Buffer.from(doc!.dataBase64, 'base64').byteLength,
      width: 2,
      height: 2,
      inputTokens: 61,
      outputTokens: 4160,
    });
  });

  it('defaults the name and asks for no size when given none', async () => {
    const generate = returning();
    const result = await tool(generate).execute({}, context());
    expect(documentsOf(result.meta)[0]?.title).toBe('image.png');
    expect(generate).toHaveBeenCalledWith(expect.anything(), {
      prompt: USER_TEXT,
      outputFormat: 'png',
    });
  });

  it('works the size out from a ratio the chat model chose', async () => {
    const generate = returning();
    await tool(generate).execute({ filename: 'wide.png', aspectRatio: '16:9' }, context());
    expect(generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ size: '1360x768' })
    );
  });

  it('saves under the extension of what the model actually returned, and says so', async () => {
    const result = await tool(returning(PNG, 'image/png')).execute(
      { filename: 'fox.jpg' },
      context()
    );
    expect(result.isError).toBe(false);
    expect(documentsOf(result.meta)[0]).toMatchObject({ mediaType: 'image/png', title: 'fox.png' });
    expect(result.content[0]?.text).toMatch(/saved as fox\.png rather than fox\.jpg/);
  });

  it('does not keep what rode along with the pixels', async () => {
    const result = await tool(returning(Buffer.concat([PNG, SCRIPT]))).execute(
      { filename: 'a.png' },
      context()
    );
    expect(result.isError).toBe(false);
    expect(Buffer.from(documentsOf(result.meta)[0]!.dataBase64, 'base64').includes(SCRIPT)).toBe(
      false
    );
  });

  it('refuses a returned file that is not the image it claims to be, keeping and counting nothing', async () => {
    const recordImageUsage = jest.fn(async () => {});
    const result = await tool(
      returning(Buffer.from('<html><script>alert(1)</script></html>'))
    ).execute({ filename: 'a.png' }, context({ recordImageUsage }));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not a valid PNG, so it was not kept/);
    expect(documentsOf(result.meta)).toEqual([]);
    expect(recordImageUsage).not.toHaveBeenCalled();
  });
});

describe('chat_generate_image — a size the model will not draw', () => {
  it('retries at the nearest standard size, and tells the model what it got', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce(err('invalid_request' as never, { message: 'size not supported' }))
      .mockResolvedValueOnce(
        ok({ bytes: PNG, mediaType: 'image/png', usage: null })
      ) as unknown as typeof generateImage;
    const result = await tool(generate).execute(
      { filename: 'a.png', size: '1792x1024' },
      context()
    );
    expect(result.isError).toBe(false);
    const sizes = (generate as unknown as jest.Mock).mock.calls.map((call) => call[1].size);
    expect(sizes).toEqual(['1792x1024', '1536x1024']);
    // The fake draws 2x2, so the note names what was actually drawn.
    expect(result.content[0]?.text).toMatch(/does not draw 1792x1024, so it was drawn at 2x2/);
  });

  it('lets a model that can choose pick for itself as the last resort', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce(err('invalid_request' as never, { message: 'no' }))
      .mockResolvedValueOnce(err('invalid_request' as never, { message: 'no' }))
      .mockResolvedValueOnce(
        ok({ bytes: PNG, mediaType: 'image/png', usage: null })
      ) as unknown as typeof generateImage;
    const result = await tool(generate).execute(
      { filename: 'a.png', size: '1792x1024' },
      context()
    );
    expect(result.isError).toBe(false);
    const sizes = (generate as unknown as jest.Mock).mock.calls.map((call) => call[1].size);
    expect(sizes).toEqual(['1792x1024', '1536x1024', undefined]);
  });

  it('gives FLUX no auto rung, and reports every size tried when all are rejected', async () => {
    const flux = jest.fn(async (_db: unknown, _t: string, id: string | null) =>
      ok({
        modelConfigId: id ?? 'img-1',
        label: 'x',
        config: { apiKey: 'k', model: 'FLUX.2-flex', surface: 'flux' as const },
      })
    ) as unknown as typeof resolveImageModel;
    const generate = rejecting('invalid_request', 'width must be a multiple of 16');
    const result = await tool(generate, { resolve: flux }).execute(
      { filename: 'a.png', size: '1792x1024' },
      context()
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/sizes tried: 1792x1024, 1536x1024\)/);
    expect(result.content[0]?.text).toMatch(/multiple of 16/);
    expect((generate as unknown as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('does not retry a failure that is not about the request', async () => {
    for (const type of ['content_filter', 'rate_limit', 'auth', 'network']) {
      const generate = rejecting(type);
      await tool(generate).execute({ filename: 'a.png', size: '1792x1024' }, context());
      expect((generate as unknown as jest.Mock).mock.calls).toHaveLength(1);
    }
  });
});

describe('chat_generate_image — building on an earlier picture', () => {
  const SOURCE = { bytes: PNG, mediaType: 'image/png' as const, filename: 'cute_polar_bear.png' };
  const loads = (
    result: Awaited<
      ReturnType<NonNullable<Parameters<typeof imageGenerationTool>[0]['loadSource']>>
    >
  ) => jest.fn(async () => result);
  const withSource = (generate: typeof generateImage, loadSource: ReturnType<typeof loads>) =>
    imageGenerationTool({ models, generate, resolve: resolveOk, loadSource })!;

  it('sends the named picture to the image model with the person’s unchanged message', async () => {
    const generate = returning();
    const loadSource = loads({ ok: true, image: SOURCE });
    const result = await withSource(generate, loadSource).execute(
      { filename: 'bluer.png', sourceImage: 'last' },
      context({ userPrompt: 'make it bluer' })
    );
    expect(result.isError).toBe(false);
    // Looked up in this chat, by what the chat model named.
    expect(loadSource).toHaveBeenCalledWith({ db: null, tenantId: 't', chatId: 'c' }, 'last');
    expect(generate).toHaveBeenCalledWith(expect.anything(), {
      prompt: 'make it bluer',
      outputFormat: 'png',
      image: SOURCE,
    });
    expect(result.content[0]?.text).toMatch(/built on cute_polar_bear\.png/);
    expect(documentsOf(result.meta)[0]?.title).toBe('bluer.png');
  });

  it('passes the name the chat model gave, trimmed', async () => {
    const loadSource = loads({ ok: true, image: SOURCE });
    await withSource(returning(), loadSource).execute(
      { filename: 'a.png', sourceImage: '  fox.png ' },
      context()
    );
    expect(loadSource).toHaveBeenCalledWith(expect.anything(), 'fox.png');
  });

  it('draws a new picture, loading nothing, when no source is named', async () => {
    for (const input of [{}, { sourceImage: '' }, { sourceImage: '   ' }, { sourceImage: 3 }]) {
      const generate = returning();
      const loadSource = loads({ ok: true, image: SOURCE });
      await withSource(generate, loadSource).execute({ filename: 'a.png', ...input }, context());
      expect(loadSource).not.toHaveBeenCalled();
      expect(generate).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({ image: expect.anything() })
      );
    }
  });

  it('still asks for the shape the model chose when it builds on a picture', async () => {
    const generate = returning();
    await withSource(generate, loads({ ok: true, image: SOURCE })).execute(
      { filename: 'a.png', sourceImage: 'last', aspectRatio: '16:9' },
      context()
    );
    expect(generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ size: '1360x768', image: SOURCE })
    );
  });

  it('refuses, spending nothing, when the picture cannot be found — saying what is there', async () => {
    const generate = returning();
    const recordImageUsage = jest.fn(async () => {});
    const reason =
      'No image called "x.png" in this chat. Its images, newest first: fox.png. Use one of those names, or "last".';
    const result = await withSource(generate, loads({ ok: false, reason })).execute(
      { filename: 'a.png', sourceImage: 'x.png' },
      context({ recordImageUsage })
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(reason);
    expect(generate).not.toHaveBeenCalled();
    expect(recordImageUsage).not.toHaveBeenCalled();
  });

  it('suggests drawing anew when the image model cannot build on a picture', async () => {
    const generate = rejecting('invalid_request', 'This model does not support image editing');
    const result = await withSource(generate, loads({ ok: true, image: SOURCE })).execute(
      { filename: 'a.png', sourceImage: 'last' },
      context()
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/does not support image editing/);
    expect(result.content[0]?.text).toMatch(/call again without sourceImage/);
  });

  it('does not suggest that for an ordinary rejected request', async () => {
    const result = await tool(rejecting('invalid_request')).execute(
      { filename: 'a.png' },
      context()
    );
    expect(result.content[0]?.text).not.toMatch(/sourceImage/);
  });

  it('counts an edit in the ledger like any picture', async () => {
    const recordImageUsage = jest.fn(async () => {});
    await withSource(returning(), loads({ ok: true, image: SOURCE })).execute(
      { filename: 'a.png', sourceImage: 'last' },
      context({ recordImageUsage })
    );
    expect(recordImageUsage).toHaveBeenCalledTimes(1);
  });
});

describe('chat_generate_image — refusing before spending anything', () => {
  it('refuses a bad name, extension, shape or background without calling the image model', async () => {
    const generate = returning();
    const t = tool(generate);
    for (const input of [
      { filename: '../a.png' },
      { filename: 'a.gif' },
      { filename: 'a.tiff' },
      { filename: 'a.png', size: 'huge' },
      { filename: 'a.png', aspectRatio: 'wide' },
      { filename: 'a.jpg', background: 'transparent' },
    ]) {
      expect((await t.execute(input, context())).isError).toBe(true);
    }
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('chat_generate_image — when the image model fails', () => {
  it.each([
    ['content_filter', /safety system refused/],
    ['rate_limit', /rate-limited/],
    ['auth', /rejected its credentials/],
    ['timeout', /took too long/],
    ['network', /could not be reached/],
    ['invalid_request', /rejected the request/],
  ])('explains %s', async (type, message) => {
    const result = await tool(rejecting(type)).execute({ filename: 'a.png' }, context());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(message);
    expect(documentsOf(result.meta)).toEqual([]);
  });

  it('counts nothing when nothing was drawn', async () => {
    const recordImageUsage = jest.fn(async () => {});
    await tool(rejecting('content_filter')).execute(
      { filename: 'a.png' },
      context({ recordImageUsage })
    );
    expect(recordImageUsage).not.toHaveBeenCalled();
  });
});
