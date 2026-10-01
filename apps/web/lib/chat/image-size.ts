/**
 * The shape of a requested picture, shared by the image tool (what to ask
 * the model for, and what to fall back to when it will not draw that) and
 * the chat's loading skeleton (what outline to show while it is drawn).
 * Pure — no database, no browser — so both can import it.
 *
 * The model chooses the shape: `size` as pixels ("1792x1024"), or
 * `aspectRatio` as a ratio ("16:9"). Image models differ in what they
 * accept — gpt-image-1 takes three sizes, gpt-image-2 and FLUX any
 * multiple of 16 within limits — so a size one rejects is retried at the
 * nearest size every model takes (STANDARD_SIZES), then left to the model
 * to choose ('auto').
 */

/** The image tool's name; here, not in image-tools.ts, so the thread (a client bundle) can know it. */
export const IMAGE_TOOL = 'chat_generate_image';

export interface Dimensions {
  width: number;
  height: number;
}

/** The sizes every gpt-image and FLUX model accepts: square, portrait, landscape. */
export const STANDARD_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;

/** A side a model could plausibly draw; past these the request is refused before it costs anything. */
const MIN_SIDE = 64;
const MAX_SIDE = 8192;
/** What a ratio becomes in pixels: about one megapixel, a size every model handles. */
const TARGET_AREA = 1024 * 1024;
const DERIVED_MIN_SIDE = 256;
const DERIVED_MAX_SIDE = 3840;
/** The widest or tallest a ratio may be; the models' own limit is 3:1. */
const MAX_RATIO = 3;

export function formatSize({ width, height }: Dimensions): string {
  return `${width}x${height}`;
}

/** "1792x1024" (or "1792×1024") as pixels; null when it is not that or is out of range. */
export function parseSize(raw: unknown): Dimensions | null {
  if (typeof raw !== 'string') return null;
  const match = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(raw);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < MIN_SIDE || height < MIN_SIDE || width > MAX_SIDE || height > MAX_SIDE) return null;
  return { width, height };
}

/** "16:9" (or "16/9", "1.5:1") as width over height; null when it is not a positive ratio. */
export function parseAspectRatio(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (!match) return null;
  const ratio = Number(match[1]) / Number(match[2]);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

const toMultipleOf16 = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value / 16) * 16));

/** A ratio as about a megapixel of pixels, multiples of 16, within the 3:1 every model allows. */
export function sizeFromRatio(ratio: number): Dimensions {
  const clamped = Math.min(MAX_RATIO, Math.max(1 / MAX_RATIO, ratio));
  const height = Math.sqrt(TARGET_AREA / clamped);
  return {
    width: toMultipleOf16(height * clamped, DERIVED_MIN_SIDE, DERIVED_MAX_SIDE),
    height: toMultipleOf16(height, DERIVED_MIN_SIDE, DERIVED_MAX_SIDE),
  };
}

/** The standard size closest in shape to this one: landscape, portrait, or square. */
export function nearestStandardSize({
  width,
  height,
}: Dimensions): (typeof STANDARD_SIZES)[number] {
  const ratio = width / height;
  if (ratio > 1.2) return '1536x1024';
  if (ratio < 1 / 1.2) return '1024x1536';
  return '1024x1024';
}

/**
 * The longest side of an animated GIF's frames. Each frame is a separate
 * picture the image model is paid to draw, so they are kept small: a
 * smaller picture costs fewer tokens (gpt-image) or megapixels (FLUX).
 */
export const GIF_MAX_SIDE = 512;

/**
 * The size an animation's frames are kept at: the shape asked for (square
 * when none was), shrunk to fit GIF_MAX_SIDE, in multiples of 16 (what the
 * models that take any size want), never under MIN_SIDE.
 */
export function animationSize(requested: Dimensions | null): Dimensions {
  const { width, height } = requested ?? { width: GIF_MAX_SIDE, height: GIF_MAX_SIDE };
  const scale = Math.min(1, GIF_MAX_SIDE / Math.max(width, height));
  const side = (value: number) => toMultipleOf16(value * scale, MIN_SIDE, GIF_MAX_SIDE);
  return { width: side(width), height: side(height) };
}

export type RequestedShape = { ok: true; size: Dimensions | null } | { ok: false; reason: string };

/**
 * What the model asked for: `size` wins when both are given; neither is
 * "let the model choose". A value that is not understood is refused with
 * the formats that are.
 */
export function requestedShape(input: { size?: unknown; aspectRatio?: unknown }): RequestedShape {
  const hasSize = typeof input.size === 'string' && input.size.trim() !== '';
  if (hasSize && String(input.size).trim().toLowerCase() !== 'auto') {
    const parsed = parseSize(input.size);
    if (!parsed) {
      return {
        ok: false,
        reason: `size must be pixels as WIDTHxHEIGHT (for example 1792x1024), each side ${MIN_SIDE}–${MAX_SIDE}, or "auto"; or give aspectRatio such as 16:9.`,
      };
    }
    return { ok: true, size: parsed };
  }
  if (typeof input.aspectRatio === 'string' && input.aspectRatio.trim() !== '') {
    const ratio = parseAspectRatio(input.aspectRatio);
    if (ratio === null) {
      return {
        ok: false,
        reason: 'aspectRatio must be width:height, for example 16:9, 3:2 or 1:1.',
      };
    }
    return { ok: true, size: sizeFromRatio(ratio) };
  }
  return { ok: true, size: null };
}

/**
 * The sizes to try in order: the one asked for; then the nearest standard
 * size, if it differs; then — for a model that can choose for itself —
 * `null`, which means "auto". Starts with `null` alone when none was asked.
 */
export function sizeLadder(requested: Dimensions | null, canChoose: boolean): (string | null)[] {
  if (!requested) return [null];
  const asked = formatSize(requested);
  const ladder: (string | null)[] = [asked];
  const standard = nearestStandardSize(requested);
  if (standard !== asked) ladder.push(standard);
  if (canChoose) ladder.push(null);
  return ladder;
}

/**
 * The outline's shape while a picture is drawn, from the tool's input as
 * it stands — complete JSON, or the half-streamed text of one: width over
 * height, or the square it falls back to when nothing was asked.
 */
export function skeletonRatio(input: unknown, partialJson?: string): number {
  let record: { size?: unknown; aspectRatio?: unknown } = {};
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    record = { size: Reflect.get(input, 'size'), aspectRatio: Reflect.get(input, 'aspectRatio') };
  }
  if (partialJson) {
    // The input is still arriving: read what has landed of the two fields.
    const size = /"size"\s*:\s*"([^"]*)"/.exec(partialJson)?.[1];
    const aspect = /"aspectRatio"\s*:\s*"([^"]*)"/.exec(partialJson)?.[1];
    record = { size: size ?? record.size, aspectRatio: aspect ?? record.aspectRatio };
  }
  const shape = requestedShape(record);
  if (shape.ok && shape.size) return shape.size.width / shape.size.height;
  return 1;
}

/**
 * Whether the call asks for an animation — a .gif filename — from its
 * input as it stands, complete or half-streamed; for the card's wording.
 */
export function isAnimationCall(input: unknown, partialJson?: string): boolean {
  let filename: unknown =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? Reflect.get(input, 'filename')
      : undefined;
  if (partialJson) filename = /"filename"\s*:\s*"([^"]*)"/.exec(partialJson)?.[1] ?? filename;
  return typeof filename === 'string' && /\.gif\s*$/i.test(filename);
}
