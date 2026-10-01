/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for fakes that never touch it */
/**
 * chat_generate_image's promises: offered only when the org has an image
 * generation model; sends the prompt to that model (never a chat model)
 * with the options asked for; keeps what comes back as a rebuilt PNG or
 * JPEG, never as given, and refuses a file that is not the image it
 * claims to be; and turns every failure into words the model can act on.
 */

import { err, ok } from '@campfhir/safe-functions/helpers';
import type { generateImage, resolveImageModel } from '@renkei/agent-llm';
import type { LocalToolContext } from './local-tools';
import { IMAGE_TOOL, imageGenerationTool } from './image-tools';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAA1BMVEX/AAAZ4gk3AAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC',
  'base64'
);
const SCRIPT = Buffer.from('<script>alert(1)</script>');

const models = [
  { id: 'img-1', label: 'Painter', model: 'gpt-image-1' },
  { id: 'img-2', label: 'Sketcher', model: 'gpt-image-2' },
];

function context(extra: Partial<LocalToolContext> = {}): LocalToolContext {
  return {
    db: null as unknown as LocalToolContext['db'],
    tenantId: 't',
    subject: 'u',
    chatId: 'c',
    projectId: null,
    readOnly: false,
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
    config: { apiKey: 'k', model: 'gpt-image-1' },
  })
) as unknown as typeof resolveImageModel;

function tool(generate: typeof generateImage, resolve = resolveOk) {
  return imageGenerationTool({ models, generate, resolve })!;
}
const returning = (bytes: Buffer, mediaType: 'image/png' | 'image/jpeg' = 'image/png') =>
  jest.fn(async () => ok({ bytes, mediaType })) as unknown as typeof generateImage;

beforeEach(() => jest.clearAllMocks());

describe('chat_generate_image — offering', () => {
  it('is not offered when the org has no image generation model', () => {
    expect(imageGenerationTool({ models: [] })).toBeNull();
  });

  it('tells the model to use it rather than refuse, and names the image models', () => {
    const def = tool(returning(PNG)).def;
    expect(def.name).toBe(IMAGE_TOOL);
    expect(def.description).toMatch(/cannot draw pixels yourself/);
    expect(def.description).toMatch(/rather than saying it is not possible/);
    expect(def.description).toMatch(/"Painter", "Sketcher"/);
    expect(def.inputSchema.required).toEqual(['prompt', 'filename']);
    expect(Object.keys(def.inputSchema.properties ?? {})).toContain('model');
  });

  it('offers a choice of model only when there is one to choose', () => {
    const single = imageGenerationTool({ models: [models[0]!] })!;
    expect(Object.keys(single.def.inputSchema.properties ?? {})).not.toContain('model');
  });
});

describe('chat_generate_image — making an image', () => {
  it('sends the prompt and options to the first image model and keeps a PNG', async () => {
    const generate = returning(PNG);
    const result = await tool(generate).execute(
      {
        prompt: 'a red square',
        filename: 'sq.png',
        size: '1024x1536',
        quality: 'low',
        background: 'transparent',
      },
      context()
    );
    expect(result.isError).toBe(false);
    expect(generate).toHaveBeenCalledWith(
      { apiKey: 'k', model: 'gpt-image-1' },
      {
        prompt: 'a red square',
        size: '1024x1536',
        quality: 'low',
        background: 'transparent',
        outputFormat: 'png',
      }
    );
    expect(resolveOk).toHaveBeenCalledWith(null, 't', 'img-1');
    const [doc] = documentsOf(result.meta);
    expect(doc).toMatchObject({ mediaType: 'image/png', title: 'sq.png' });
    expect(Buffer.from(doc!.dataBase64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(result.meta.renkeiDocumentsShown).toBe(false);
    expect(result.content[0]?.text).toMatch(/Generated sq\.png with Painter/);
  });

  it('asks for a JPEG when the name says so, and ignores options it was not given', async () => {
    const jpeg = jest.fn(async () =>
      ok({ bytes: PNG, mediaType: 'image/jpeg' as const })
    ) as unknown as typeof generateImage;
    await tool(jpeg).execute({ prompt: 'p', filename: 'a.JPG', size: 'huge' }, context());
    expect(jpeg).toHaveBeenCalledWith(expect.anything(), { prompt: 'p', outputFormat: 'jpeg' });
  });

  it('uses the model named, by label or model id', async () => {
    await tool(returning(PNG)).execute(
      { prompt: 'p', filename: 'a.png', model: 'sketcher' },
      context()
    );
    expect(resolveOk).toHaveBeenLastCalledWith(null, 't', 'img-2');
    await tool(returning(PNG)).execute(
      { prompt: 'p', filename: 'a.png', model: 'gpt-image-1' },
      context()
    );
    expect(resolveOk).toHaveBeenLastCalledWith(null, 't', 'img-1');
  });

  it('does not keep what rode along with the pixels', async () => {
    const result = await tool(returning(Buffer.concat([PNG, SCRIPT]))).execute(
      { prompt: 'p', filename: 'a.png' },
      context()
    );
    expect(result.isError).toBe(false);
    const kept = Buffer.from(documentsOf(result.meta)[0]!.dataBase64, 'base64');
    expect(kept.includes(SCRIPT)).toBe(false);
  });

  it('refuses a returned file that is not the image it claims to be, keeping nothing', async () => {
    for (const bytes of [
      Buffer.from('<html><script>alert(1)</script></html>'),
      Buffer.from('MZ\x90\x00'),
    ]) {
      const result = await tool(returning(bytes)).execute(
        { prompt: 'p', filename: 'a.png' },
        context()
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/not a valid PNG, so it was not kept/);
      expect(documentsOf(result.meta)).toEqual([]);
    }
  });
});

describe('chat_generate_image — refusing before spending anything', () => {
  it('refuses a bad brief, name, extension, model or background without calling the image model', async () => {
    const generate = returning(PNG);
    const t = tool(generate);
    for (const input of [
      { prompt: '  ', filename: 'a.png' },
      { prompt: 'p', filename: '../a.png' },
      { prompt: 'p', filename: 'a.gif' },
      { prompt: 'p', filename: 'a.tiff' },
      { prompt: 'p', filename: 'a.png', model: 'A Chat Model' },
      { prompt: 'p', filename: 'a.jpg', background: 'transparent' },
    ]) {
      expect((await t.execute(input, context())).isError).toBe(true);
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it('says so when the chosen model cannot be used right now', async () => {
    const generate = returning(PNG);
    const gone = jest.fn(async () =>
      err('NO_MODEL' as const, { message: 'none' })
    ) as unknown as typeof resolveImageModel;
    const result = await tool(generate, gone).execute(
      { prompt: 'p', filename: 'a.png' },
      context()
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/"Painter" cannot be used right now/);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('chat_generate_image — when the image model fails', () => {
  const failing = (type: string, message = 'detail') =>
    jest.fn(async () => err(type as never, { message })) as unknown as typeof generateImage;

  it.each([
    ['content_filter', /safety system refused/],
    ['rate_limit', /rate-limited/],
    ['auth', /rejected its credentials/],
    ['timeout', /took too long/],
    ['invalid_request', /size or option/],
    ['network', /could not be reached/],
  ])('explains %s', async (type, message) => {
    const result = await tool(failing(type)).execute({ prompt: 'p', filename: 'a.png' }, context());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(message);
    expect(documentsOf(result.meta)).toEqual([]);
  });
});
