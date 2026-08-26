/**
 * Whether a tool call read something or changed something.
 *
 * The WRITER lives in `apps/web/lib/mcp-tools/kind-stamp.ts`, because only
 * registration knows the answer — it comes from the tool's own
 * `readOnlyHint` annotation, applied during a per-user registration against
 * a database. The READER lives here because the agents worker is what
 * consumes it, and the worker cannot import from `apps/web`.
 *
 * That split is the whole reason for this file: two small halves in the
 * two places that can reach them, sharing one key so they cannot disagree
 * about the name of the thing.
 */

/** The `_meta` key carrying 'read' | 'act' on a tool result. */
export const KIND_META_KEY = 'renkei/kind';

export type ToolKind = 'read' | 'act';

/**
 * The stamp on a result's `_meta`, or null when it carries none.
 *
 * Null means NOT KNOWN, never "read" — a result recorded before the stamp
 * existed, or produced by a path that does not go through registration.
 * A caller that treats the absence as a read will under-report what an
 * agent did, which is the direction that matters.
 */
export function toolKindOf(meta: Record<string, unknown> | undefined): ToolKind | null {
  const value = meta?.[KIND_META_KEY];
  return value === 'read' || value === 'act' ? value : null;
}
