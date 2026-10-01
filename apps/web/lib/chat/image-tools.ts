/**
 * chat_generate_image — the model's way to have a picture drawn. A chat
 * model does not produce image bytes; an image generation model does (the
 * org's rows whose API surface is Images or FLUX — gpt-image-1,
 * FLUX.2-flex and the like, never chat). This tool sends the person's
 * message to one of them and keeps what comes back as a PNG or JPEG under
 * the chat's Artifacts, through the same door chat_write_file uses.
 *
 * The prompt is the person's own message, word for word: the chat model
 * does not write or rewrite it, so what is drawn is what was asked for.
 * The chat model chooses only the shape (`size` or `aspectRatio`) and the
 * file's name. A shape the image model will not draw is retried at the
 * nearest size every model takes, then left to the model to choose.
 *
 * A follow-up that builds on an earlier picture ("make it bluer") is an
 * EDIT: the chat model, which can see the conversation, names that picture
 * with `sourceImage` (a file in this chat, or "last"), and the tool sends it
 * to the image model together with the person's unchanged message. The tool
 * never decides for itself that a message refers to an earlier picture;
 * without `sourceImage` it draws a new one.
 *
 * Which image model: the person's saved preference when the org still
 * offers it, else the org's first by name. The chat model cannot override
 * the person's choice.
 *
 * What comes back is untrusted bytes from a remote service, so it is not
 * kept as given: @renkei/document-render parses it and REBUILDS the image
 * from its pixels (metadata, trailing data and polyglot payloads do not
 * survive). A file that is not the image it claims to be is refused.
 *
 * A .gif filename asks for an ANIMATION: a few small frames (at most
 * GIF_MAX_SIDE on a side, so each costs few tokens), the first drawn from
 * the person's message (or built on `sourceImage`), each later one an edit
 * of the frame before it, then encoded here as one looping GIF from the
 * frames' pixels. Each frame's prompt is the person's message followed by
 * one line this tool writes — which frame it is, and to change only what
 * moves — fixed wording, never the chat model's. Every frame drawn is
 * counted in the ledger as it is drawn, since each was paid for.
 *
 * Offered only where the org has somewhere to keep files AND an enabled
 * image generation model (chat-local-tools.ts), so the model is never
 * given a verb that can only fail. Spending money is an act, so the turn
 * asks the person first like any other act tool. Every picture kept is
 * counted in the image ledger (migration 132).
 */

import {
  generateImage as callImagesApi,
  resolveImageModel,
  type ImageErrorKind,
  type ImageModelConfig,
} from '@renkei/agent-llm';
import {
  coverRgba,
  decodePng,
  encodeGif,
  encodePng,
  extensionOf,
  sanitizeBytes,
  type RgbaImage,
} from '@renkei/document-render';
import { checkFilename, KEPT_LINE } from './file-tools';
import {
  animationSize,
  formatSize,
  GIF_MAX_SIDE,
  IMAGE_TOOL,
  requestedShape,
  sizeLadder,
  type Dimensions,
} from './image-size';
import {
  loadSourceImage,
  type SourceImage,
  type SourceLoad,
  type SourceScope,
} from './image-source';
import { errorResult, textResult, type LocalTool, type LocalToolContext } from './local-tools';
import type { McpToolResult } from '@renkei/mcp-client';
import type { ImageModelChoice } from './models';

export { IMAGE_TOOL };

/** Several attempts at several sizes — or several frames — each up to the API call's own timeout. */
export const IMAGE_TOOL_TIMEOUT_MS = 600_000;
/** gpt-image's own limit; a longer message is refused rather than clipped, because the prompt is theirs. */
export const IMAGE_PROMPT_MAX_CHARS = 32_000;

const QUALITIES = ['low', 'medium', 'high'] as const;
const BACKGROUNDS = ['auto', 'transparent'] as const;
/** A model draws PNG or JPEG; an extension names which. A .gif is an animation of PNG frames. */
const EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif'] as const;
const DEFAULT_FILENAME = 'image.png';

/** An animation's frame count: enough to move, few enough to stay cheap and inside the quota. */
export const GIF_MIN_FRAMES = 2;
export const GIF_MAX_FRAMES = 6;
const GIF_DEFAULT_FRAMES = 4;
/** How long each frame shows; the drawn frames are far apart, so slower than video. */
const GIF_MIN_DELAY_MS = 50;
const GIF_MAX_DELAY_MS = 2_000;
const GIF_DEFAULT_DELAY_MS = 300;
/** Room left in the prompt for the line this tool adds to each frame. */
const FRAME_LINE_RESERVE = 400;

/**
 * The one line this tool adds to the person's message for an animation's
 * frame: which frame it is, and — for every frame after the first, which
 * is drawn from the one before — to change only what moves.
 */
export function frameLine(index: number, count: number): string {
  if (index === 1) {
    return `\n\n(Frame 1 of ${count} of a short looping animation of the above: draw its opening moment, simply composed so the motion reads at a small size.)`;
  }
  const last =
    index === count ? ' This is the last frame: it should lead naturally back into the first.' : '';
  return `\n\n(Frame ${index} of ${count} of a short looping animation of the above. Redraw the given image as the next moment of that motion: change only what moves, and keep the scene, framing, style, colours and characters the same.${last})`;
}

/** A whole number from the model's input within [min, max], or the default when it gave none. */
function wholeWithin(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
    return null;
  }
  return number;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

function failureMessage(
  kind: ImageErrorKind,
  detail: string | undefined,
  tried: string,
  edited: boolean
): string {
  const extra = detail ? ` (${detail.slice(0, 300)})` : '';
  switch (kind) {
    case 'content_filter':
      return `The image model’s safety system refused this prompt or the picture it made. Tell the person, and offer to try a different description.${extra}`;
    case 'rate_limit':
      return `The image model is rate-limited right now (image generation has a low per-minute quota). Tell the person to try again in a minute.${extra}`;
    case 'auth':
      return `The image model rejected its credentials; an administrator needs to check the model’s key.${extra}`;
    case 'timeout':
      return `The image model took too long. Try a smaller size.${extra}`;
    case 'aborted':
      return 'Image generation was stopped.';
    case 'invalid_request':
      return (
        `The image model rejected the request${tried ? ` (sizes tried: ${tried})` : ''}.${extra}` +
        (edited
          ? ' It may not support building on an earlier image: call again without sourceImage to draw a new one.'
          : '')
      );
    default:
      return `The image model could not be reached or failed.${extra}`;
  }
}

export interface ImageToolOptions {
  /** The org's enabled image generation models, in the order the first is the default. */
  models: ImageModelChoice[];
  /** The person's saved choice, if any; used only while the org still offers it. */
  preferredModelId?: string | null;
  /** The Images API call — real by default, a fake in tests. */
  generate?: typeof callImagesApi;
  /** How a chosen row becomes a config with its key — real by default. */
  resolve?: typeof resolveImageModel;
  /** Finds and reads back an earlier picture of the chat — real by default. */
  loadSource?: (scope: SourceScope, wanted: string) => Promise<SourceLoad>;
}

/** The model a picture is drawn with: the person's own pick if still offered, else the first. */
export function pickImageModel(
  models: ImageModelChoice[],
  preferredModelId: string | null | undefined
): ImageModelChoice | null {
  return models.find((entry) => entry.id === preferredModelId) ?? models[0] ?? null;
}

/** The image tool, or null when the org has no image generation model. */
export function imageGenerationTool(options: ImageToolOptions): LocalTool | null {
  const { models } = options;
  if (models.length === 0) return null;
  const generate = options.generate ?? callImagesApi;
  const resolve = options.resolve ?? resolveImageModel;
  const loadSource = options.loadSource ?? loadSourceImage;

  /**
   * An animated GIF: frame 1 from the person's message (or the source
   * picture), each later frame an edit of the one before, all cut down to
   * `size`, then encoded as one GIF. The size that worked for frame 1 is
   * the only one asked for after it, so a model that will not draw small
   * is not retried down the ladder on every frame.
   */
  async function animate(job: {
    prompt: string;
    filename: string;
    size: Dimensions;
    frames: number;
    delayMs: number;
    quality: (typeof QUALITIES)[number];
    config: ImageModelConfig;
    label: string;
    source: SourceImage | null;
    context: LocalToolContext;
  }): Promise<McpToolResult> {
    const { config, context } = job;
    let ladder = sizeLadder(job.size, config.surface !== 'flux');
    const kept: RgbaImage[] = [];
    let previous = job.source;
    for (let index = 1; index <= job.frames; index++) {
      const tried: string[] = [];
      let made: Awaited<ReturnType<typeof generate>> | null = null;
      for (const size of ladder) {
        tried.push(size ?? 'auto');
        made = await generate(config, {
          prompt: job.prompt + frameLine(index, job.frames),
          ...(size ? { size } : {}),
          quality: job.quality,
          // Frames are decoded to pixels here, and PNG is the format that can be.
          outputFormat: 'png',
          ...(previous ? { image: previous } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        if (made.ok) {
          ladder = [size];
          break;
        }
        if (made.err.type !== 'invalid_request') break;
      }
      const progress = index > 1 ? ` Frame ${index} of ${job.frames} failed; no GIF was kept.` : '';
      if (!made) return errorResult('Image generation did not run.');
      if (!made.ok) {
        return errorResult(
          failureMessage(made.err.type, made.err.message, tried.join(', '), previous !== null) +
            progress
        );
      }
      const pixels =
        made.val.mediaType === 'image/png'
          ? decodePng(made.val.bytes)
          : {
              ok: false as const,
              reason: 'it answered a JPEG, and a GIF is made from PNG frames.',
            };
      if (!pixels.ok) {
        return errorResult(
          `The image model returned a frame that could not be used, so no GIF was kept: ${pixels.reason}`
        );
      }
      // Each frame was paid for, so it is counted whether or not the GIF is finished.
      if (context.recordImageUsage) {
        await context.recordImageUsage({
          surface: config.surface ?? 'images',
          provider: 'openai',
          model: config.model,
          imageBytes: made.val.bytes.byteLength,
          width: pixels.image.width,
          height: pixels.image.height,
          inputTokens: made.val.usage?.inputTokens ?? 0,
          outputTokens: made.val.usage?.outputTokens ?? 0,
        });
      }
      // A frame drawn in another shape (a size fallback) is trimmed to the one asked for, not stretched.
      const frame = coverRgba(pixels.image, job.size.width, job.size.height);
      kept.push(frame);
      // The next frame starts from this one, small: fewer input tokens, the same picture.
      previous = {
        bytes: encodePng(frame),
        mediaType: 'image/png',
        filename: `frame-${index}.png`,
      };
    }

    const gif = encodeGif(kept, { delayMs: job.delayMs });
    const drawn = formatSize(job.size);
    return textResult(
      `Generated ${job.filename} with ${job.label} (image/gif, a looping animation of ${kept.length} frames at ${drawn} px, ${job.delayMs} ms each, ${gif.byteLength} bytes)${job.source ? `, built on ${job.source.filename}` : ''}. ${KEPT_LINE}`,
      {
        renkeiDocuments: [
          { mediaType: 'image/gif', dataBase64: gif.toString('base64'), title: job.filename },
        ],
        renkeiDocumentsShown: false,
      }
    );
  }

  return {
    def: {
      name: IMAGE_TOOL,
      description:
        'Generate an image for the person to keep: a picture, illustration, logo, icon, photo-style render, ' +
        'texture, or any scene described in words. You cannot draw pixels yourself, so whenever the person ' +
        'asks for an image call this rather than saying it is not possible. The image model is given the ' +
        'person’s own message exactly as they wrote it — you do not write or change the prompt, so just call ' +
        'this with the shape you think suits what they asked for. The result appears inline in the chat and ' +
        'under its Artifacts as a PNG or JPEG — or, with a .gif filename, as a short looping animated GIF ' +
        `of a few small frames (at most ${GIF_MAX_SIDE}px a side) when the person asks for a GIF or an animation. ` +
        'Choose the shape yourself: size as pixels (1024x1024 square, ' +
        '1024x1536 portrait, 1536x1024 landscape, or another WIDTHxHEIGHT such as 1792x1024) or aspectRatio ' +
        '(16:9, 4:3, 9:16, …) — a size the image model does not support is automatically retried at the ' +
        'nearest one it does. When the person’s message builds on a picture already in this chat — ' +
        '“make it bluer”, “same bear but in winter”, “add a hat” — set sourceImage to that picture’s ' +
        'filename (or "last" for the one most recently drawn) so the image model changes that picture ' +
        'instead of starting over; leave it out for a brand-new picture. For a chart, graph or flowchart use chat_write_chart (it is exact); for a ' +
        'document use chat_write_file. Each call makes one image (a .gif, one per frame) and may take up to a minute each; image generation ' +
        'has a low per-minute quota, so do not call it in a burst. Describe the result in a sentence.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: `The name to save as; the extension picks the format (.png or .jpg, or .gif for an animation). A name, not a path. Default: ${DEFAULT_FILENAME}.`,
          },
          frames: {
            type: 'integer',
            minimum: GIF_MIN_FRAMES,
            maximum: GIF_MAX_FRAMES,
            description: `.gif only: how many frames the animation has (${GIF_MIN_FRAMES}–${GIF_MAX_FRAMES}). Each frame is a separate picture the image model draws, so fewer is faster and cheaper. Default: ${GIF_DEFAULT_FRAMES}.`,
          },
          frameDelayMs: {
            type: 'integer',
            minimum: GIF_MIN_DELAY_MS,
            maximum: GIF_MAX_DELAY_MS,
            description: `.gif only: how long each frame shows, in milliseconds. Default: ${GIF_DEFAULT_DELAY_MS}.`,
          },
          sourceImage: {
            type: 'string',
            description:
              'An earlier PNG or JPEG in this chat to start from — its filename, or "last" for the picture most recently drawn. Set it when the person’s message refers to that picture (“make it bluer”); omit it to draw something new. The size of the result follows that picture unless you set size or aspectRatio.',
          },
          size: {
            type: 'string',
            description:
              'The picture’s size in pixels as WIDTHxHEIGHT (1024x1024, 1536x1024, 1792x1024, …), or auto to let the image model choose. Overrides aspectRatio.',
          },
          aspectRatio: {
            type: 'string',
            description:
              'The picture’s shape as width:height (1:1, 3:2, 16:9, 9:16, …); the size in pixels is worked out for you. Use this when you know the shape but not the pixels.',
          },
          quality: {
            type: 'string',
            enum: [...QUALITIES],
            description:
              'low is fastest and cheapest; high is the most detailed. Default: the model’s own (low for a .gif’s frames). Ignored by models without a quality setting (FLUX).',
          },
          background: {
            type: 'string',
            enum: [...BACKGROUNDS],
            description:
              'transparent gives a PNG with a transparent background (a logo, a sticker). Ignored by models that cannot (FLUX).',
          },
        },
        required: [],
      },
    },
    timeoutMs: IMAGE_TOOL_TIMEOUT_MS,
    async execute(input, context) {
      // The person's words, untouched: this is the whole point of not taking a prompt.
      const prompt = (context.userPrompt ?? '').trim();
      if (!prompt) {
        return errorResult(
          'There is no message from the person to draw from. Ask them what image they want.'
        );
      }
      const animated = typeof input.filename === 'string' && /\.gif\s*$/i.test(input.filename);
      const promptLimit = IMAGE_PROMPT_MAX_CHARS - (animated ? FRAME_LINE_RESERVE : 0);
      if (prompt.length > promptLimit) {
        return errorResult(
          `The person’s message is ${prompt.length} characters; an image prompt can be at most ${promptLimit}. Ask them for a shorter description.`
        );
      }
      const name = checkFilename(
        typeof input.filename === 'string' && input.filename.trim()
          ? input.filename
          : DEFAULT_FILENAME
      );
      if (!name.ok) return errorResult(name.reason);
      const extension = extensionOf(name.filename);
      if (!extension || !oneOf(EXTENSIONS, extension)) {
        return errorResult('filename must end in .png, .jpg or .jpeg — or .gif for an animation.');
      }
      const frames = wholeWithin(input.frames, GIF_MIN_FRAMES, GIF_MAX_FRAMES, GIF_DEFAULT_FRAMES);
      const delayMs = wholeWithin(
        input.frameDelayMs,
        GIF_MIN_DELAY_MS,
        GIF_MAX_DELAY_MS,
        GIF_DEFAULT_DELAY_MS
      );
      if (extension === 'gif' && frames === null) {
        return errorResult(
          `frames must be a whole number from ${GIF_MIN_FRAMES} to ${GIF_MAX_FRAMES}.`
        );
      }
      if (extension === 'gif' && delayMs === null) {
        return errorResult(
          `frameDelayMs must be a whole number of milliseconds from ${GIF_MIN_DELAY_MS} to ${GIF_MAX_DELAY_MS}.`
        );
      }
      const shape = requestedShape(input);
      if (!shape.ok) return errorResult(shape.reason);
      const background = oneOf(BACKGROUNDS, input.background);
      if (background === 'transparent' && extension !== 'png') {
        return errorResult('A transparent background needs a .png filename.');
      }

      const choice = pickImageModel(models, options.preferredModelId);
      if (!choice) return errorResult('No image model is available.');
      const resolved = await resolve(context.db, context.tenantId, choice.id);
      if (!resolved.ok || resolved.val.modelConfigId !== choice.id) {
        return errorResult(
          `The image model "${choice.label}" cannot be used right now (it is disabled or its configuration is incomplete). Tell the person to ask an administrator.`
        );
      }
      const config = resolved.val.config;

      // A follow-up starts from the picture it names; found before anything is spent.
      const wantedSource = typeof input.sourceImage === 'string' ? input.sourceImage.trim() : null;
      let source: Extract<SourceLoad, { ok: true }>['image'] | null = null;
      if (wantedSource !== null && wantedSource !== '') {
        const loaded = await loadSource(
          { db: context.db, tenantId: context.tenantId, chatId: context.chatId },
          wantedSource
        );
        if (!loaded.ok) return errorResult(loaded.reason);
        source = loaded.image;
      }

      if (extension === 'gif') {
        return animate({
          prompt,
          filename: name.filename,
          size: animationSize(shape.size),
          frames: frames ?? GIF_DEFAULT_FRAMES,
          delayMs: delayMs ?? GIF_DEFAULT_DELAY_MS,
          quality: oneOf(QUALITIES, input.quality) ?? 'low',
          config,
          label: choice.label,
          source,
          context,
        });
      }

      const quality = oneOf(QUALITIES, input.quality);
      // A model that can choose for itself ('images') has a last resort; FLUX has none.
      const ladder = sizeLadder(shape.size, config.surface !== 'flux');
      let made: Awaited<ReturnType<typeof generate>> | null = null;
      const tried: string[] = [];
      for (const size of ladder) {
        tried.push(size ?? 'auto');
        made = await generate(config, {
          prompt,
          ...(size ? { size } : {}),
          ...(quality ? { quality } : {}),
          ...(background ? { background } : {}),
          outputFormat: extension === 'png' ? 'png' : 'jpeg',
          ...(source ? { image: source } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        // Only a rejected request is worth another size; anything else would fail the same way.
        if (made.ok || made.err.type !== 'invalid_request') break;
      }
      if (!made) return errorResult('Image generation did not run.');
      if (!made.ok) {
        return errorResult(
          failureMessage(
            made.err.type,
            made.err.message,
            tried.length > 1 || shape.size ? tried.join(', ') : '',
            source !== null
          )
        );
      }

      // The bytes decide the format, not the request: FLUX answers PNG whatever is asked.
      const actual = made.val.mediaType === 'image/jpeg' ? 'jpg' : 'png';
      const asked = extension === 'png' ? 'png' : 'jpg';
      const filename =
        actual === asked
          ? name.filename
          : `${name.filename.slice(0, name.filename.lastIndexOf('.'))}.${actual}`;
      const renamed =
        filename === name.filename
          ? ''
          : ` This model produces ${actual.toUpperCase()}, so it was saved as ${filename} rather than ${name.filename}.`;
      // Untrusted bytes: rebuilt from the pixels, or refused.
      const checked = sanitizeBytes(actual, made.val.bytes);
      if (!checked.ok) {
        return errorResult(
          `The image model returned a file that is not a valid ${actual.toUpperCase()}, so it was not kept: ${checked.reason}`
        );
      }

      const drawn =
        checked.width && checked.height
          ? formatSize({ width: checked.width, height: checked.height })
          : null;
      const wanted = shape.size ? formatSize(shape.size) : null;
      const resized =
        wanted && drawn && wanted !== drawn
          ? ` The image model does not draw ${wanted}, so it was drawn at ${drawn} instead.`
          : '';
      // Counted once it is kept: a refused or failed call drew nothing.
      if (context.recordImageUsage) {
        await context.recordImageUsage({
          surface: config.surface ?? 'images',
          provider: 'openai',
          model: config.model,
          imageBytes: checked.bytes.byteLength,
          width: checked.width ?? null,
          height: checked.height ?? null,
          inputTokens: made.val.usage?.inputTokens ?? 0,
          outputTokens: made.val.usage?.outputTokens ?? 0,
        });
      }
      return textResult(
        `Generated ${filename} with ${choice.label} (${checked.mediaType}, ${drawn ? `${drawn} px, ` : ''}${checked.bytes.byteLength} bytes)${source ? `, built on ${source.filename}` : ''}.${resized}${renamed} ${KEPT_LINE}`,
        {
          renkeiDocuments: [
            {
              mediaType: checked.mediaType,
              dataBase64: checked.bytes.toString('base64'),
              title: filename,
            },
          ],
          // The model asked for it by shape; it does not need the pixels back.
          renkeiDocumentsShown: false,
        }
      );
    },
  };
}
