/**
 * Moved to `@renkei/tool-outcomes`, because `apps/worker-agents` — where a
 * tool result is actually seen — cannot import from `apps/web`.
 *
 * This shim exists so the move was not also a rename in a dozen call sites.
 * New code should import from the package directly.
 */

export {
  CURATED_OUTCOMES,
  GENERIC_FAILURES,
  OTHER_FAILURE,
  OUTCOME_META_KEY,
  genericOutcomes,
  outcomeError,
  resolveOutcomes,
  type ToolFailureOutcome,
  type ToolOutcomes,
} from '@renkei/tool-outcomes';
