/**
 * Cosine distance as a word a person (or a model) can act on.
 *
 * The raw number is backwards (smaller is closer), unitless, and — the
 * part that bit us — model-dependent: text-embedding-3 puts genuinely good
 * matches at 0.5–0.7, where a bge or e5 model puts them under 0.3. Fixed
 * bands read one of those models correctly and call the other's best hits
 * "weak". So the bands are relative to the org's configured cutoff when it
 * has one (see `KnowledgeTuning.maxDistance`): the cutoff is where an
 * admin decided matches stop being worth showing, and everything closer
 * is graded against it. The fixed bands remain the default for orgs that
 * have not calibrated.
 */

export type Relevance = 'strong' | 'good' | 'possible' | 'weak';

/** The bands used when no cutoff is configured — right for cosine-normalised models around bge/e5. */
export const DEFAULT_RELEVANCE_BANDS = { strong: 0.25, good: 0.4, possible: 0.55 } as const;

/** Where each band ends, as a fraction of the configured cutoff. */
const RELATIVE_BANDS = { strong: 0.5, good: 0.75, possible: 1 } as const;

export const RELEVANCE_LABELS: Record<Relevance, string> = {
  strong: 'Strong match',
  good: 'Good match',
  possible: 'Possible match',
  weak: 'Weak match',
};

export function relevanceOf(distance: number, maxDistance?: number | null): Relevance {
  if (!Number.isFinite(distance)) return 'weak';
  const bands =
    typeof maxDistance === 'number' && Number.isFinite(maxDistance) && maxDistance > 0
      ? {
          strong: maxDistance * RELATIVE_BANDS.strong,
          good: maxDistance * RELATIVE_BANDS.good,
          possible: maxDistance * RELATIVE_BANDS.possible,
        }
      : DEFAULT_RELEVANCE_BANDS;
  if (distance <= bands.strong) return 'strong';
  if (distance <= bands.good) return 'good';
  if (distance <= bands.possible) return 'possible';
  return 'weak';
}
