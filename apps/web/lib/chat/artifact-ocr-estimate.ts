/**
 * How long an OCR run has left, from the runs that already finished. The
 * connector answers one call per file, so nothing is known about pages
 * still to read while a run is in flight; the estimate is the median time
 * of finished runs of about the same size (or, with too few of those, the
 * median time per byte across all of them, scaled to this file). It is
 * only a guide, and says how many runs it was built from.
 *
 * Kept free of framework imports so the arithmetic can be tested alone.
 */

export interface OcrSample {
  sizeBytes: number;
  millis: number;
}

export interface OcrEstimate {
  /** Milliseconds left by the estimate, or null when there is no estimate yet. */
  remainingMs: number | null;
  /** The run has taken longer than the estimate it was given. */
  overdue: boolean;
  /** The estimate's full duration, for a bar that moves with the run. */
  totalMs: number | null;
  /** Finished runs the estimate was built from. */
  basedOn: number;
}

/** A file this many times bigger or smaller than another is not "similar" to it. */
export const SIMILAR_SIZE_FACTOR = 2;
/** Fewer finished runs than this give no estimate at all. */
export const MIN_SAMPLES = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function estimateOcrRemaining(
  samples: OcrSample[],
  sizeBytes: number,
  elapsedMs: number
): OcrEstimate {
  const similar = samples.filter(
    (sample) =>
      sample.sizeBytes >= sizeBytes / SIMILAR_SIZE_FACTOR &&
      sample.sizeBytes <= sizeBytes * SIMILAR_SIZE_FACTOR
  );
  let totalMs: number | null = null;
  let basedOn = samples.length;
  if (similar.length >= MIN_SAMPLES) {
    totalMs = median(similar.map((sample) => sample.millis));
    basedOn = similar.length;
  } else if (samples.length >= MIN_SAMPLES) {
    const perByte = median(
      samples
        .filter((sample) => sample.sizeBytes > 0)
        .map((sample) => sample.millis / sample.sizeBytes)
    );
    totalMs = perByte * sizeBytes;
  }
  // Without an estimate, basedOn is how many finished runs there are so far,
  // so the page can say how many more it is waiting for.
  if (totalMs === null) return { remainingMs: null, overdue: false, totalMs: null, basedOn };
  const overdue = elapsedMs >= totalMs;
  return {
    remainingMs: overdue ? null : Math.round(totalMs - elapsedMs),
    overdue,
    totalMs: Math.round(totalMs),
    basedOn,
  };
}
