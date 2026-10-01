/**
 * chat_generate_image — the model's way to have a picture drawn. A chat
 * model does not produce image bytes; an image generation model does (the
 * org's "Image generation model" rows — gpt-image-1, gpt-image-2 and the
 * like, spoken to through the Images API, never chat). This tool sends the
 * model's prompt to one of them and keeps what comes back as a PNG or JPEG
 * under the chat's Artifacts, through the same door chat_write_file uses.
 *
 * What comes back is untrusted bytes from a remote service, so it is not
 * kept as given: @renkei/document-render parses it and REBUILDS the image
 * from its pixels (metadata, trailing data and polyglot payloads do not
 * survive). A file that is not the image it claims to be is refused.
 *
 * Offered only where the org has somewhere to keep files AND an enabled
 * image generation model (chat-local-tools.ts), so the model is never
 * given a verb that can only fail. Spending money is an act, so the turn
 * asks the person first like any other act tool.
 */

import {
  generateImage as callImagesApi,
  resolveImageModel,
  type ImageErrorKind,
} from '@renkei/agent-llm';
import { extensionOf, sanitizeBinary } from '@renkei/document-render';
import { checkFilename, KEPT_LINE } from './file-tools';
import { errorResult, textResult, type LocalTool } from './local-tools';
import type { ImageModelChoice } from './models';

export const IMAGE_TOOL = 'chat_generate_image';

/** Image models take several minutes at the outside; past the API call's own timeout. */
export const IMAGE_TOOL_TIMEOUT_MS = 200_000;
export const IMAGE_PROMPT_MAX_CHARS = 8_000;

/** Sizes every gpt-image model accepts; 'auto' lets the model choose. */
const SIZES = ['auto', '1024x1024', '1024x1536', '1536x1024'] as const;
const QUALITIES = ['low', 'medium', 'high'] as const;
const BACKGROUNDS = ['auto', 'transparent'] as const;
/** A model draws PNG or JPEG; an extension names which. */
const EXTENSIONS = ['png', 'jpg', 'jpeg'] as const;

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

function failureMessage(kind: ImageErrorKind, detail: string | undefined): string {
  const extra = detail ? ` (${detail.slice(0, 300)})` : '';
  switch (kind) {
    case 'content_filter':
      return `The image model’s safety system refused this prompt or the picture it made. Tell the person, and offer to try a different description.${extra}`;
    case 'rate_limit':
      return `The image model is rate-limited right now (image generation has a low per-minute quota). Tell the person to try again in a minute.${extra}`;
    case 'auth':
      return `The image model rejected its credentials; an administrator needs to check the model’s key.${extra}`;
    case 'timeout':
      return `The image model took too long. Try a simpler description or a smaller size.${extra}`;
    case 'aborted':
      return 'Image generation was stopped.';
    case 'invalid_request':
      return `The image model rejected the request — often a size or option it does not support.${extra}`;
    default:
      return `The image model could not be reached or failed.${extra}`;
  }
}

export interface ImageToolOptions {
  /** The org's enabled image generation models. */
  models: ImageModelChoice[];
  /** The Images API call — real by default, a fake in tests. */
  generate?: typeof callImagesApi;
  /** How a chosen row becomes a config with its key — real by default. */
  resolve?: typeof resolveImageModel;
}

/** The image tool, or null when the org has no image generation model. */
export function imageGenerationTool(options: ImageToolOptions): LocalTool | null {
  const { models } = options;
  if (models.length === 0) return null;
  const generate = options.generate ?? callImagesApi;
  const resolve = options.resolve ?? resolveImageModel;
  const names = models.map((choice) => `"${choice.label}"`).join(', ');

  return {
    def: {
      name: IMAGE_TOOL,
      description:
        'Generate an image for the person to keep: a picture, illustration, logo, icon, photo-style render, ' +
        'texture, or any scene described in words. You cannot draw pixels yourself, so ' +
        'whenever the person asks for an image call this rather than saying it is not possible — it sends ' +
        'your prompt to an image generation model. The result appears under this chat’s Artifacts as a PNG or ' +
        'JPEG. Write a rich prompt: subject, composition, setting, lighting, colours, style, and any exact text ' +
        'to appear. For a chart, graph or flowchart use chat_write_chart (it is exact); for a document use ' +
        'chat_write_file. Each call makes one image and may take up to a minute; image generation has a low ' +
        'per-minute quota, so do not call it in a burst. Tell the person where the image is and describe it in ' +
        'a sentence. ' +
        (models.length > 1
          ? `Image models available: ${names}; pick one with model, or omit it for the first.`
          : `It uses the organization’s image model ${names}.`),
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            minLength: 1,
            maxLength: IMAGE_PROMPT_MAX_CHARS,
            description: 'The complete description of the image to make.',
          },
          filename: {
            type: 'string',
            description:
              'The name to save as; the extension picks the format (.png or .jpg). A name, not a path. Default format: PNG.',
          },
          size: {
            type: 'string',
            enum: [...SIZES],
            description:
              'auto (default; the model chooses), 1024x1024 square, 1024x1536 portrait, 1536x1024 landscape.',
          },
          quality: {
            type: 'string',
            enum: [...QUALITIES],
            description:
              'low is fastest and cheapest; high is the most detailed. Default: model’s own.',
          },
          background: {
            type: 'string',
            enum: [...BACKGROUNDS],
            description:
              'transparent gives a PNG with a transparent background (a logo, a sticker).',
          },
          ...(models.length > 1
            ? {
                model: {
                  type: 'string',
                  maxLength: 200,
                  description: `The image model, by label: ${names}.`,
                },
              }
            : {}),
        },
        required: ['prompt', 'filename'],
      },
    },
    timeoutMs: IMAGE_TOOL_TIMEOUT_MS,
    async execute(input, context) {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) return errorResult('Say what the image should show.');
      if (prompt.length > IMAGE_PROMPT_MAX_CHARS) {
        return errorResult(`prompt is at most ${IMAGE_PROMPT_MAX_CHARS} characters.`);
      }
      const name = checkFilename(input.filename);
      if (!name.ok) return errorResult(name.reason);
      const extension = extensionOf(name.filename);
      if (!extension || !oneOf(EXTENSIONS, extension)) {
        return errorResult('filename must end in .png, .jpg or .jpeg.');
      }
      const wanted = typeof input.model === 'string' ? input.model.trim().toLowerCase() : '';
      const choice = wanted
        ? models.find(
            (entry) => entry.label.toLowerCase() === wanted || entry.model.toLowerCase() === wanted
          )
        : models[0];
      if (!choice) {
        return errorResult(
          `No image model called "${input.model}". Choose one of: ${names} — or leave model out.`
        );
      }
      const resolved = await resolve(context.db, context.tenantId, choice.id);
      if (!resolved.ok || resolved.val.modelConfigId !== choice.id) {
        return errorResult(
          `The image model "${choice.label}" cannot be used right now (it is disabled or its configuration is incomplete).`
        );
      }
      const background = oneOf(BACKGROUNDS, input.background);
      if (background === 'transparent' && extension !== 'png') {
        return errorResult('A transparent background needs a .png filename.');
      }

      const size = oneOf(SIZES, input.size);
      const quality = oneOf(QUALITIES, input.quality);
      const made = await generate(resolved.val.config, {
        prompt,
        ...(size ? { size } : {}),
        ...(quality ? { quality } : {}),
        ...(background ? { background } : {}),
        outputFormat: extension === 'png' ? 'png' : 'jpeg',
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (!made.ok) return errorResult(failureMessage(made.err.type, made.err.message));

      // Untrusted bytes: rebuilt from the pixels, or refused.
      const checked = sanitizeBinary(extension, made.val.bytes.toString('base64'));
      if (!checked.ok) {
        return errorResult(
          `The image model returned a file that is not a valid ${extension.toUpperCase()}, so it was not kept: ${checked.reason}`
        );
      }
      return textResult(
        `Generated ${name.filename} with ${choice.label} (${checked.mediaType}, ${checked.bytes.byteLength} bytes). ${KEPT_LINE}`,
        {
          renkeiDocuments: [
            {
              mediaType: checked.mediaType,
              dataBase64: checked.bytes.toString('base64'),
              title: name.filename,
            },
          ],
          // The model asked for it by description; it does not need the pixels back.
          renkeiDocumentsShown: false,
        }
      );
    },
  };
}
