/**
 * One picture, drawn — the core the two image tools share: the chat's
 * chat_generate_image (lib/chat/image-tools.ts) and the org agents'
 * sandbox_generate_image (lib/mcp-tools/sandbox/images.ts). Given a
 * resolved image model, the prompt, the shape asked for and the format
 * the caller named, it asks the model — down the size ladder when the
 * model will not draw that shape — rebuilds what comes back from its
 * pixels (untrusted bytes from a remote service are never kept as given;
 * @renkei/document-render's validators), and answers the bytes with what
 * to tell the model about them, or the reason it failed in words the
 * model can act on.
 *
 * Where the picture is kept (attached to the chat, staged in the scratch
 * space) and that it is counted in the image ledger stay with the
 * caller; so does the choice of prompt, which is the one thing the two
 * tools differ on (the chat sends the person's own words; an agent has
 * none and writes its own).
 */

import {
  type generateImage,
  type ImageErrorKind,
  type ImageModelConfig,
  type ImageRequest,
  type ImageUsage,
} from '@renkei/agent-llm';
import { sanitizeBytes } from '@renkei/document-render';
import { formatSize, sizeLadder, type Dimensions } from '@/lib/chat/image-size';

/** A picture to build on, already rebuilt by the caller. */
export type SourcePicture = NonNullable<ImageRequest['image']>;

export const IMAGE_QUALITIES = ['low', 'medium', 'high'] as const;
export const IMAGE_BACKGROUNDS = ['auto', 'transparent'] as const;
/** A model draws PNG or JPEG; an extension names which. */
export const STILL_EXTENSIONS = ['png', 'jpg', 'jpeg'] as const;
export type StillExtension = (typeof STILL_EXTENSIONS)[number];

export interface DrawInput {
  config: ImageModelConfig;
  /** The caller's name for the input that carries `source`, for the message when an edit is refused. */
  sourceInputName?: string;
  prompt: string;
  /** The shape asked for; null leaves it to the model. */
  size: Dimensions | null;
  /** What the caller named the file: decides the format asked for. */
  extension: StillExtension;
  quality?: (typeof IMAGE_QUALITIES)[number];
  background?: (typeof IMAGE_BACKGROUNDS)[number];
  /** A picture to start from, which makes the call an edit. */
  source?: SourcePicture | null;
  signal?: AbortSignal;
}

export interface DrawnPicture {
  /** Rebuilt from the pixels; safe to keep. */
  bytes: Buffer;
  mediaType: 'image/png' | 'image/jpeg';
  /** What actually came back — FLUX answers PNG whatever is asked — so the file is named truthfully. */
  extension: 'png' | 'jpg';
  width: number | null;
  height: number | null;
  /** Tokens the provider billed, when it said. */
  usage: ImageUsage | null;
  /** What to tell the model beside the picture: a size the model would not draw, say. */
  notes: string[];
}

export type DrawOutcome = { ok: true; picture: DrawnPicture } | { ok: false; message: string };

/**
 * The failure, in words the model can act on. `edited` names the input
 * that carried the source picture (sourceImage, sourceFileId) when the
 * call was an edit, so a model that cannot edit is told what to leave out.
 */
export function failureMessage(
  kind: ImageErrorKind,
  detail: string | undefined,
  tried: string,
  edited: string | null
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
          ? ` It may not support building on an earlier image: call again without ${edited} to draw a new one.`
          : '')
      );
    default:
      return `The image model could not be reached or failed.${extra}`;
  }
}

/** The name a picture is kept under, given what the model actually drew. */
export function nameForFormat(
  filename: string,
  extension: 'png' | 'jpg'
): { filename: string; renamed: string } {
  const dot = filename.lastIndexOf('.');
  const asked = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  const askedFormat = asked === 'png' ? 'png' : 'jpg';
  if (askedFormat === extension) return { filename, renamed: '' };
  const kept = `${dot > 0 ? filename.slice(0, dot) : filename}.${extension}`;
  return {
    filename: kept,
    renamed: ` This model produces ${extension.toUpperCase()}, so it was saved as ${kept} rather than ${filename}.`,
  };
}

/**
 * Asks the model for one picture. Only a rejected request (the shape,
 * most often) is worth another size down the ladder; anything else would
 * fail the same way. A model that can choose for itself ('images') has
 * `auto` as a last resort; FLUX has none.
 */
export async function drawPicture(
  generate: typeof generateImage,
  input: DrawInput
): Promise<DrawOutcome> {
  const { config } = input;
  const source = input.source ?? null;
  const ladder = sizeLadder(input.size, config.surface !== 'flux');
  let made: Awaited<ReturnType<typeof generate>> | null = null;
  const tried: string[] = [];
  for (const size of ladder) {
    tried.push(size ?? 'auto');
    made = await generate(config, {
      prompt: input.prompt,
      ...(size ? { size } : {}),
      ...(input.quality ? { quality: input.quality } : {}),
      ...(input.background ? { background: input.background } : {}),
      outputFormat: input.extension === 'png' ? 'png' : 'jpeg',
      ...(source ? { image: source } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (made.ok || made.err.type !== 'invalid_request') break;
  }
  if (!made) return { ok: false, message: 'Image generation did not run.' };
  if (!made.ok) {
    return {
      ok: false,
      message: failureMessage(
        made.err.type,
        made.err.message,
        tried.length > 1 || input.size ? tried.join(', ') : '',
        source !== null ? (input.sourceInputName ?? 'the source image') : null
      ),
    };
  }

  // The bytes decide the format, not the request.
  const extension = made.val.mediaType === 'image/jpeg' ? 'jpg' : 'png';
  // Untrusted bytes: rebuilt from the pixels, or refused.
  const checked = sanitizeBytes(extension, made.val.bytes);
  if (!checked.ok) {
    return {
      ok: false,
      message: `The image model returned a file that is not a valid ${extension.toUpperCase()}, so it was not kept: ${checked.reason}`,
    };
  }
  const notes: string[] = [];
  const drawn =
    checked.width && checked.height
      ? formatSize({ width: checked.width, height: checked.height })
      : null;
  const wanted = input.size ? formatSize(input.size) : null;
  if (wanted && drawn && wanted !== drawn) {
    notes.push(`The image model does not draw ${wanted}, so it was drawn at ${drawn} instead.`);
  }
  return {
    ok: true,
    picture: {
      bytes: checked.bytes,
      mediaType: checked.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      extension,
      width: checked.width ?? null,
      height: checked.height ?? null,
      usage: made.val.usage,
      notes,
    },
  };
}
