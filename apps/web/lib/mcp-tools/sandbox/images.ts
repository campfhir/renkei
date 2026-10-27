/**
 * sandbox_generate_image — a picture for an org agent, drawn by the
 * organization's image generation model from the agent's own description
 * and staged in the caller's scratch space, where sandbox_run_python can
 * place it in a document (python-docx, python-pptx, reportlab) and
 * sandbox_send_to_upload can move it anywhere a *_request_*_upload tool
 * reaches. The chat's chat_generate_image (lib/chat/image-tools.ts) is
 * the same drawing (lib/image/draw.ts) attached to the chat instead — and
 * drawn from the person's own words, which an agent has none of: here the
 * prompt is the agent's, written for the document it is making, and the
 * result says so.
 *
 * Which image model: the caller's saved preference while the org still
 * offers it, else the org's first by name — the chat's rule. What comes
 * back is untrusted bytes, rebuilt from the pixels before it is kept
 * (draw.ts), and every picture kept is counted in the image ledger
 * (lib/image/usage.ts) against the caller.
 *
 * Registered only where the organization has an enabled image generation
 * model (and, being under registerSandboxTools, a sandbox worker) — closed,
 * never open. Spending money is an act, so an agent's approval policy
 * applies as to any other act tool.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  generateImage as callImagesApi,
  resolveImageModel as resolveImageModelRow,
} from '@renkei/agent-llm';
import { sanitizeBytes } from '@renkei/document-render';
import { validateFilename } from '@renkei/connector-sandbox';
import { getDatabase } from '@renkei/db';
import { getImagePrefs } from '@renkei/user-prefs';
import type { MCPToolContext } from '../common';
import { errText, fileLine, str, targetOf, textResult } from './shared';
import { sbReadFile, sbWriteFile, clientFailure } from '@/lib/sandbox/service-client';
import { listImageModels, type ImageModelChoice } from '@/lib/chat/models';
import { pickImageModel } from '@/lib/chat/image-tools';
import { formatSize, requestedShape } from '@/lib/chat/image-size';
import {
  drawPicture,
  IMAGE_BACKGROUNDS,
  IMAGE_QUALITIES,
  nameForFormat,
  STILL_EXTENSIONS,
  type SourcePicture,
} from '@/lib/image/draw';
import { recordImageUsage as recordImageUsageRow, type ImageUsageReport } from '@/lib/image/usage';

export const SANDBOX_IMAGE_TOOL = 'sandbox_generate_image';
/** gpt-image's own limit; the chat tool's too. */
export const SANDBOX_IMAGE_PROMPT_MAX_CHARS = 32_000;
const DEFAULT_FILENAME = 'image.png';

/**
 * The org's enabled image models, for deciding whether to register the
 * tool at all. Any trouble reading them — no database in this process,
 * a query that fails — means no image model: the tool is withheld rather
 * than offered to fail.
 */
export async function sandboxImageModels(): Promise<ImageModelChoice[]> {
  try {
    return await listImageModels();
  } catch {
    return [];
  }
}

export interface SandboxImageToolDeps {
  /** The org's enabled image generation models, the first by name the default. */
  models: ImageModelChoice[];
  /** The Images API call — real by default, a fake in tests. */
  generate?: typeof callImagesApi;
  /** How a chosen row becomes a config with its key — real by default. */
  resolve?: typeof resolveImageModelRow;
  /** The caller's saved image model, if any — real by default. */
  preferredModelId?: (subject: string) => Promise<string | null>;
  /** Where a picture kept is counted — real by default. */
  recordUsage?: (subject: string, report: ImageUsageReport) => Promise<void>;
}

async function savedModelId(subject: string): Promise<string | null> {
  try {
    return (await getImagePrefs(subject)).modelId;
  } catch {
    return null;
  }
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

export function registerSandboxImageTools(
  server: McpServer,
  context: MCPToolContext,
  deps: SandboxImageToolDeps
): void {
  if (deps.models.length === 0) return;
  const generate = deps.generate ?? callImagesApi;
  const resolve = deps.resolve ?? resolveImageModelRow;
  const preferredModelId = deps.preferredModelId ?? savedModelId;
  const recordUsage =
    deps.recordUsage ??
    (async (subject: string, report: ImageUsageReport) => {
      const db = getDatabase();
      if (db.ok) await recordImageUsageRow(db.val, { ...report, subject });
    });

  server.registerTool(
    SANDBOX_IMAGE_TOOL,
    {
      title: 'Sandbox · Act — Generate an image, staged in your scratch space',
      description:
        'Draw a picture with the organization’s image generation model — an illustration, a ' +
        'cover, a figure for a slide, a logo, a photo-style render, any scene described in words — ' +
        'and stage it in your scratch space as a PNG or JPEG. You cannot draw pixels yourself; ' +
        'this is how a picture for a document you are making comes to be: describe it in prompt, ' +
        'then place the staged file in the document with sandbox_run_python (python-docx, ' +
        'python-pptx, reportlab read it from in/), or move it anywhere a *_request_*_upload ' +
        'tool reaches with sandbox_send_to_upload. For a chart, graph or flowchart use ' +
        'sandbox_render_chart instead (it is exact). Choose the shape: size as pixels ' +
        '(1024x1024 square, 1024x1536 portrait, 1536x1024 landscape, or another WIDTHxHEIGHT) ' +
        'or aspectRatio (16:9, 4:3, 9:16, …) — a size the image model does not support is ' +
        'retried at the nearest one it does, and the result says what was drawn. To change a ' +
        'picture already staged here (a PNG or JPEG), name it with sourceFileId and describe ' +
        'the change. Each call makes one image and may take up to a minute; image generation ' +
        'has a low per-minute quota and costs money, so do not call it in a burst.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .max(SANDBOX_IMAGE_PROMPT_MAX_CHARS)
          .describe(
            'What to draw, in detail, as the image model should draw it (at most ' +
              `${SANDBOX_IMAGE_PROMPT_MAX_CHARS} characters). Say "no text" when the picture should carry none.`
          ),
        filename: z
          .string()
          .max(255)
          .optional()
          .describe(
            `Name to stage the file as; the extension picks the format (.png or .jpg). A name, not a path. Default: ${DEFAULT_FILENAME}.`
          ),
        size: z
          .string()
          .max(16)
          .optional()
          .describe(
            'The picture’s size in pixels as WIDTHxHEIGHT (1024x1024, 1536x1024, …), or auto to let the image model choose. Overrides aspectRatio.'
          ),
        aspectRatio: z
          .string()
          .max(16)
          .optional()
          .describe(
            'The picture’s shape as width:height (1:1, 3:2, 16:9, 9:16, …); the size in pixels is worked out for you.'
          ),
        quality: z
          .enum(IMAGE_QUALITIES)
          .optional()
          .describe(
            'low is fastest and cheapest; high is the most detailed. Default: the model’s own. Ignored by models without a quality setting (FLUX).'
          ),
        background: z
          .enum(IMAGE_BACKGROUNDS)
          .optional()
          .describe(
            'transparent gives a PNG with a transparent background (a logo, a sticker). Ignored by models that cannot (FLUX).'
          ),
        sourceFileId: z
          .string()
          .uuid()
          .optional()
          .describe(
            'A PNG or JPEG already staged in your scratch space to build on (its id from sandbox_list_files or an earlier call): the image model changes that picture as the prompt says instead of starting over.'
          ),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);

      const prompt = str(args.prompt).trim();
      if (!prompt) return errText('Describe the picture in prompt.');
      if (prompt.length > SANDBOX_IMAGE_PROMPT_MAX_CHARS) {
        return errText(
          `The prompt is ${prompt.length} characters; at most ${SANDBOX_IMAGE_PROMPT_MAX_CHARS}. Describe the picture more briefly.`
        );
      }
      const named = validateFilename(str(args.filename).trim() || DEFAULT_FILENAME);
      if (!named.ok) return errText('filename must be a name, not a path, and not empty.');
      const dot = named.filename.lastIndexOf('.');
      const extension = oneOf(
        STILL_EXTENSIONS,
        dot > 0 ? named.filename.slice(dot + 1).toLowerCase() : ''
      );
      if (!extension) return errText('filename must end in .png, .jpg or .jpeg.');
      const shape = requestedShape(args);
      if (!shape.ok) return errText(shape.reason);
      const background = oneOf(IMAGE_BACKGROUNDS, args.background);
      if (background === 'transparent' && extension !== 'png') {
        return errText('A transparent background needs a .png filename.');
      }

      const choice = pickImageModel(deps.models, await preferredModelId(target.subject));
      if (!choice) return errText('No image model is available.');
      const db = getDatabase();
      if (!db.ok) return errText('Database unavailable.');
      const resolved = await resolve(db.val, choice.id);
      if (!resolved.ok || resolved.val.modelConfigId !== choice.id) {
        return errText(
          `The image model "${choice.label}" cannot be used right now (it is disabled or its configuration is incomplete). An administrator needs to check it.`
        );
      }
      const config = resolved.val.config;

      // A picture to build on is read back from the scratch space and
      // rebuilt before it goes anywhere — found before anything is spent.
      let source: SourcePicture | null = null;
      const sourceFileId = str(args.sourceFileId).trim();
      if (sourceFileId) {
        const read = await sbReadFile(target, sourceFileId);
        if (!read.ok) return errText(clientFailure(read.err).message);
        const declared = (read.val.contentType || '').split(';')[0]!.trim().toLowerCase();
        const sourceExtension =
          declared === 'image/jpeg' || /\.jpe?g$/i.test(read.val.filename) ? 'jpg' : 'png';
        const checked = sanitizeBytes(sourceExtension, Buffer.from(read.val.bytes));
        if (!checked.ok) {
          return errText(
            `"${read.val.filename}" is not a PNG or JPEG the image model can build on: ${checked.reason}`
          );
        }
        source = {
          bytes: checked.bytes,
          mediaType: sourceExtension === 'jpg' ? 'image/jpeg' : 'image/png',
          filename: read.val.filename,
        };
      }

      const drawn = await drawPicture(generate, {
        config,
        prompt,
        size: shape.size,
        extension,
        quality: oneOf(IMAGE_QUALITIES, args.quality),
        background,
        source,
        sourceInputName: 'sourceFileId',
      });
      if (!drawn.ok) return errText(drawn.message);
      const { picture } = drawn;
      const kept = nameForFormat(named.filename, picture.extension);

      // Counted once it is kept: a refused or failed call drew nothing.
      await recordUsage(target.subject, {
        surface: config.surface ?? 'images',
        provider: 'openai',
        model: config.model,
        imageBytes: picture.bytes.byteLength,
        width: picture.width,
        height: picture.height,
        inputTokens: picture.usage?.inputTokens ?? 0,
        outputTokens: picture.usage?.outputTokens ?? 0,
      });

      const staged = await sbWriteFile(
        target,
        { filename: kept.filename, contentType: picture.mediaType, source: 'image' },
        picture.bytes
      );
      if (!staged.ok) return errText(clientFailure(staged.err).message);

      const size =
        picture.width && picture.height
          ? `${formatSize({ width: picture.width, height: picture.height })} px, `
          : '';
      const notes = picture.notes.map((note) => ` ${note}`).join('');
      return textResult(
        `Generated ${kept.filename} with ${choice.label} (${picture.mediaType}, ${size}${picture.bytes.byteLength} bytes)${source ? `, built on ${source.filename}` : ''}, drawn from your prompt.${notes}${kept.renamed}\n` +
          `Staged ${fileLine(staged.val)}\n` +
          'Next: place it in a document with sandbox_run_python (it is copied under in/ by this ' +
          'filename), or request an upload endpoint with the destination’s own *_request_*_upload ' +
          'tool and call sandbox_send_to_upload with this fileId and that uploadId to move it there.'
      );
    }
  );
}
