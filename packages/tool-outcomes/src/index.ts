/**
 * What a tool did, and what it can fail at — the vocabulary shared by the
 * MCP layer that registers tools and the agents worker that calls them.
 *
 * It is a PACKAGE rather than a module under `apps/web` for one hard
 * reason: `apps/worker-agents` cannot import from `apps/web`. The worker is
 * where a tool result is actually seen (`engine.ts` dispatches every call),
 * so anything that interprets a result has to live somewhere both can
 * reach. Leaving this in the web app and copying it into the worker would
 * put the two out of step within a release — a curated label fixed in one
 * copy and not the other, silently.
 *
 * Deliberately pure: no database, no I/O, no framework. That is what lets a
 * server component, a client component, an MCP tool handler and a worker
 * all read the same table.
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
} from './outcomes';

export { connectorKeyForTool } from './tool-connector';
