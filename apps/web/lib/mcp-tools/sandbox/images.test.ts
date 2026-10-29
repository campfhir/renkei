/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * sandbox_generate_image's promises: registered only where the org has an
 * image generation model; an act tool; draws from the agent's own prompt
 * with the caller's saved model when the org still offers it, else the
 * first; takes the shape as pixels or a ratio and falls back to a size
 * the model will draw; keeps what comes back only as a rebuilt PNG or
 * JPEG, staged under the format's own extension and counted in the
 * ledger; builds on a staged picture when one is named; refuses a bad
 * input before spending anything; and turns every failure into words the
 * model can act on.
 */

jest.mock('@/lib/sandbox/service-client', () => ({
  sandboxConfig: jest.fn(() => ({ url: 'http://sandbox.internal:8092', key: 'k' })),
  sandboxFeatures: jest.fn(async () => ({
    browser: false,
    charts: false,
    workspaces: false,
    services: false,
    scripts: false,
    scriptsNetworkShared: false,
  })),
  clientFailure: jest.fn((error: { kind: string; type?: string; message?: string }) => ({
    status: 400,
    message: error.message ?? `failed: ${error.type ?? error.kind}`,
  })),
  sbFetchUrl: jest.fn(),
  sbListFiles: jest.fn(),
  sbStatFile: jest.fn(),
  sbReadFile: jest.fn(),
  sbWriteFile: jest.fn(),
  sbDeleteFile: jest.fn(),
}));
jest.mock('@/lib/chat/models', () => ({ listImageModels: jest.fn(async () => []) }));

import { err, ok } from '@campfhir/safe-functions/helpers';
import type { McpServer } from '@modelcontextprotocol/server';
import type { generateImage, resolveImageModel } from '@renkei/agent-llm';
import { listImageModels } from '@/lib/chat/models';
import { registerSandboxTools } from './index';
import {
  registerSandboxImageTools,
  SANDBOX_IMAGE_TOOL,
  sandboxImageModels,
  type SandboxImageToolDeps,
} from './images';
import type { MCPToolContext } from '../common';

const client = jest.requireMock<Record<string, jest.Mock>>('@/lib/sandbox/service-client');

type Handler = (
  args: Record<string, unknown>
) => Promise<{ content: { text: string }[]; isError?: boolean }>;
interface Registered {
  config: { annotations?: { readOnlyHint?: boolean }; description: string };
  handler: Handler;
}

function fakeServer(tools: Map<string, Registered>): McpServer {
  return {
    registerTool: (name: string, config: Registered['config'], handler: Handler) => {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
}

const context = (subject: string | null = 'auth0|alice'): MCPToolContext =>
  ({
    ...(subject ? { subject } : {}),
    origin: 'https://renkei.example',
  }) as unknown as MCPToolContext;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAA1BMVEX/AAAZ4gk3AAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC',
  'base64'
); // a real 2x2 PNG
const SCRIPT = Buffer.from('<script>alert(1)</script>');
const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const STAGED = {
  id: '22222222-2222-4222-8222-222222222222',
  filename: 'cover.png',
  contentType: 'image/png',
  sizeBytes: 70,
  source: 'image',
  batchId: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  expiresAt: '2026-10-21T10:00:00.000Z',
};

const models = [
  { id: 'img-1', label: 'Painter', model: 'gpt-image-1' },
  { id: 'img-2', label: 'Sketcher', model: 'FLUX.2-flex' },
];

const resolveOk = jest.fn(async (id: string | null) =>
  ok({
    modelConfigId: id ?? 'img-1',
    label: 'x',
    config: {
      apiKey: 'k',
      model: id === 'img-2' ? 'FLUX.2-flex' : 'gpt-image-1',
      surface: (id === 'img-2' ? 'flux' : 'images') as 'flux' | 'images',
    },
  })
) as unknown as typeof resolveImageModel;

const returning = (bytes: Buffer = PNG, mediaType: 'image/png' | 'image/jpeg' = 'image/png') =>
  jest.fn(async () =>
    ok({ bytes, mediaType, usage: { inputTokens: 7, outputTokens: 900 } })
  ) as unknown as typeof generateImage;
const rejecting = (type: string, message = 'detail') =>
  jest.fn(async () => err(type as never, { message })) as unknown as typeof generateImage;

function tool(
  generate: typeof generateImage,
  extra: Partial<SandboxImageToolDeps> = {},
  ctx = context()
): { handler: Handler; config: Registered['config']; recordUsage: jest.Mock } {
  const tools = new Map<string, Registered>();
  const recordUsage = jest.fn(async () => {});
  registerSandboxImageTools(fakeServer(tools), ctx, {
    models,
    generate,
    resolve: resolveOk,
    preferredModelId: async () => null,
    recordUsage,
    ...extra,
  });
  const registered = tools.get(SANDBOX_IMAGE_TOOL)!;
  return { handler: registered.handler, config: registered.config, recordUsage };
}

beforeEach(() => {
  jest.clearAllMocks();
  client.sbWriteFile.mockResolvedValue({ ok: true, val: STAGED });
});

describe('sandbox_generate_image — offering', () => {
  it('is registered by registerSandboxTools only where the org has an image model', async () => {
    const without = new Map<string, Registered>();
    await registerSandboxTools(fakeServer(without), context());
    expect(without.has(SANDBOX_IMAGE_TOOL)).toBe(false);

    jest.mocked(listImageModels).mockResolvedValueOnce(models);
    const withModels = new Map<string, Registered>();
    await registerSandboxTools(fakeServer(withModels), context());
    expect(withModels.has(SANDBOX_IMAGE_TOOL)).toBe(true);
    expect(withModels.get(SANDBOX_IMAGE_TOOL)?.config.annotations?.readOnlyHint).toBe(false);
  });

  it('reads no models as none when the read fails', async () => {
    jest.mocked(listImageModels).mockRejectedValueOnce(new Error('down'));
    expect(await sandboxImageModels()).toEqual([]);
  });

  it('tells the model what it is for, and where the picture goes next', () => {
    const { config } = tool(returning());
    expect(config.description).toMatch(/cannot draw pixels yourself/);
    expect(config.description).toMatch(/sandbox_run_python/);
    expect(config.description).toMatch(/sandbox_send_to_upload/);
    expect(config.description).toMatch(/sandbox_render_chart instead/);
    expect(config.description).toMatch(/sourceFileId/);
  });
});

describe('sandbox_generate_image — making a picture', () => {
  it('draws from the prompt, stages a rebuilt PNG under its name, and counts it', async () => {
    const generate = returning();
    const { handler, recordUsage } = tool(generate);
    const result = await handler({
      prompt: '  A calm watercolour of a lighthouse at dawn, no text ',
      filename: 'cover.png',
      size: '1536x1024',
      quality: 'low',
      background: 'transparent',
    });
    expect(result.isError).toBeUndefined();
    expect(generate).toHaveBeenCalledWith(
      { apiKey: 'k', model: 'gpt-image-1', surface: 'images' },
      {
        prompt: 'A calm watercolour of a lighthouse at dawn, no text',
        size: '1536x1024',
        quality: 'low',
        background: 'transparent',
        outputFormat: 'png',
      }
    );
    expect(client.sbWriteFile).toHaveBeenCalledWith(
      { subject: 'auth0|alice' },
      { filename: 'cover.png', contentType: 'image/png', source: 'image' },
      expect.any(Buffer)
    );
    const staged: Buffer = client.sbWriteFile.mock.calls[0]![2];
    expect(staged.subarray(1, 4).toString()).toBe('PNG');
    expect(result.content[0]?.text).toMatch(
      /^Generated cover\.png with Painter \(image\/png, 2x2 px, \d+ bytes\), drawn from your prompt\./
    );
    expect(result.content[0]?.text).toContain(`Staged ${STAGED.id}`);
    expect(result.content[0]?.text).toMatch(/sandbox_run_python/);
    expect(recordUsage).toHaveBeenCalledWith('auth0|alice', {
      surface: 'images',
      provider: 'openai',
      model: 'gpt-image-1',
      imageBytes: staged.byteLength,
      width: 2,
      height: 2,
      inputTokens: 7,
      outputTokens: 900,
    });
  });

  it('defaults the name, asks for no size when given none, and works one out from a ratio', async () => {
    const generate = returning();
    const { handler } = tool(generate);
    await handler({ prompt: 'A red circle' });
    expect(generate).toHaveBeenLastCalledWith(expect.anything(), {
      prompt: 'A red circle',
      outputFormat: 'png',
    });
    expect(client.sbWriteFile).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ filename: 'image.png' }),
      expect.anything()
    );
    await handler({ prompt: 'A red circle', aspectRatio: '16:9' });
    expect(generate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ size: '1360x768' })
    );
  });

  it('uses the caller’s saved model while the org offers it, else the first', async () => {
    const generate = returning();
    const saved = jest.fn(async () => 'img-2');
    await tool(generate, { preferredModelId: saved }).handler({ prompt: 'x', filename: 'a.png' });
    expect(saved).toHaveBeenCalledWith('auth0|alice');
    expect(generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'FLUX.2-flex' }),
      expect.anything()
    );
    await tool(generate, { preferredModelId: async () => 'gone' }).handler({ prompt: 'x' });
    expect(generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'gpt-image-1' }),
      expect.anything()
    );
  });

  it('stages under the extension of what actually came back, and says so', async () => {
    const { handler } = tool(returning(PNG, 'image/png'));
    const result = await handler({ prompt: 'x', filename: 'fox.jpg' });
    expect(client.sbWriteFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filename: 'fox.png', contentType: 'image/png' }),
      expect.anything()
    );
    expect(result.content[0]?.text).toMatch(/saved as fox\.png rather than fox\.jpg/);
  });

  it('retries a size the model rejects at the nearest standard one, and reports what was drawn', async () => {
    const generate = jest.fn(async (_config: unknown, request: { size?: string }) =>
      request.size === '1792x1024'
        ? err('invalid_request' as never, { message: 'bad size' })
        : ok({ bytes: PNG, mediaType: 'image/png' as const, usage: null })
    ) as unknown as typeof generateImage;
    const result = await tool(generate).handler({ prompt: 'x', size: '1792x1024' });
    expect(result.isError).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.content[0]?.text).toMatch(
      /does not draw 1792x1024, so it was drawn at 2x2 instead/
    );
  });

  it('does not keep what rode along with the pixels, and refuses a file that is not an image', async () => {
    await tool(returning(Buffer.concat([PNG, SCRIPT]))).handler({ prompt: 'x' });
    const staged: Buffer = client.sbWriteFile.mock.calls[0]![2];
    expect(staged.includes(SCRIPT)).toBe(false);

    client.sbWriteFile.mockClear();
    const { handler, recordUsage } = tool(returning(Buffer.from('<html></html>')));
    const result = await handler({ prompt: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not a valid PNG, so it was not kept/);
    expect(client.sbWriteFile).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('passes the sandbox’s refusal to stage on as the error, after the picture was counted', async () => {
    client.sbWriteFile.mockResolvedValue({
      ok: false,
      err: { kind: 'op', type: 'quota_full', message: 'The scratch space is full.', status: 413 },
    });
    const { handler, recordUsage } = tool(returning());
    const result = await handler({ prompt: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('The scratch space is full.');
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });
});

describe('sandbox_generate_image — building on a staged picture', () => {
  it('reads the named file back, rebuilds it, and sends it with the prompt as an edit', async () => {
    client.sbReadFile.mockResolvedValue({
      ok: true,
      val: { filename: 'draft.png', contentType: 'image/png', bytes: Buffer.concat([PNG, SCRIPT]) },
    });
    const generate = returning();
    const result = await tool(generate).handler({
      prompt: 'make it bluer',
      sourceFileId: SOURCE_ID,
    });
    expect(result.isError).toBeUndefined();
    expect(client.sbReadFile).toHaveBeenCalledWith({ subject: 'auth0|alice' }, SOURCE_ID);
    const request = (generate as jest.Mock).mock.calls[0]![1] as {
      image?: { bytes: Buffer; mediaType: string; filename: string };
    };
    expect(request.image?.filename).toBe('draft.png');
    expect(request.image?.mediaType).toBe('image/png');
    expect(request.image?.bytes.includes(SCRIPT)).toBe(false);
    expect(result.content[0]?.text).toMatch(/built on draft\.png/);
  });

  it('refuses a source that is not there or not an image, spending nothing', async () => {
    client.sbReadFile.mockResolvedValue({
      ok: false,
      err: { kind: 'op', type: 'not_found', message: 'No such file.', status: 404 },
    });
    const generate = returning();
    const missing = await tool(generate).handler({ prompt: 'x', sourceFileId: SOURCE_ID });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toBe('No such file.');

    client.sbReadFile.mockResolvedValue({
      ok: true,
      val: { filename: 'notes.txt', contentType: 'text/plain', bytes: Buffer.from('hello') },
    });
    const text = await tool(generate).handler({ prompt: 'x', sourceFileId: SOURCE_ID });
    expect(text.isError).toBe(true);
    expect(text.content[0]?.text).toMatch(/not a PNG or JPEG the image model can build on/);
    expect(generate).not.toHaveBeenCalled();
  });

  it('suggests drawing anew, naming sourceFileId, when the model cannot edit', async () => {
    client.sbReadFile.mockResolvedValue({
      ok: true,
      val: { filename: 'draft.png', contentType: 'image/png', bytes: PNG },
    });
    const result = await tool(rejecting('invalid_request', 'no editing')).handler({
      prompt: 'x',
      sourceFileId: SOURCE_ID,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/call again without sourceFileId/);
  });
});

describe('sandbox_generate_image — refusing before spending anything', () => {
  it.each([
    [{ prompt: '   ' }, /Describe the picture/],
    [{ prompt: 'x'.repeat(32_001) }, /at most 32000/],
    [{ prompt: 'x', filename: 'a/b.png' }, /not a path/],
    [{ prompt: 'x', filename: 'a.gif' }, /\.png, \.jpg or \.jpeg/],
    [{ prompt: 'x', size: 'huge' }, /size/],
    [{ prompt: 'x', filename: 'a.jpg', background: 'transparent' }, /needs a \.png/],
  ])('refuses %j', async (input, message) => {
    const generate = returning();
    const { handler, recordUsage } = tool(generate);
    const result = await handler(input);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(message);
    expect(generate).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(client.sbWriteFile).not.toHaveBeenCalled();
  });

  it('refuses without a signed-in identity', async () => {
    const generate = returning();
    const result = await tool(generate, {}, context(null)).handler({ prompt: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/No signed-in identity/);
    expect(generate).not.toHaveBeenCalled();
  });

  it('says so when the chosen model cannot be used right now', async () => {
    const generate = returning();
    const resolve = jest.fn(async () =>
      err('NOT_FOUND' as never, { message: 'gone' })
    ) as unknown as typeof resolveImageModel;
    const result = await tool(generate, { resolve }).handler({ prompt: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/cannot be used right now/);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('sandbox_generate_image — when the image model fails', () => {
  it.each([
    ['content_filter', /safety system refused/],
    ['rate_limit', /rate-limited/],
    ['auth', /rejected its credentials/],
    ['timeout', /took too long/],
    ['network', /could not be reached/],
  ])('explains %s, staging and counting nothing', async (type, message) => {
    const { handler, recordUsage } = tool(rejecting(type));
    const result = await handler({ prompt: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(message);
    expect(client.sbWriteFile).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
