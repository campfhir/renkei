/**
 * Name lookups for generated preview cards.
 *
 * A builder (card.ts) is pure, so it can only show what the call's arguments
 * hold — and an argument is often an id (a sprint, a page, a channel). Ids
 * are for the confirm call, not for a person, so a connector that can read
 * the name registers a lookup beside its tools, where its auth already is:
 *
 *   registerPreviewLookups(context, {
 *     jira_complete_sprint: async (args) => ({ [nameKey('sprint', id)]: 'Sprint 5' }),
 *   });
 *
 * The generated preview runs the tool's lookup (best effort, bounded) and
 * hands the answers to the builder as `names`. A lookup that fails, times
 * out or finds nothing just leaves the entry out; the builder then says
 * "the sprint", never the id. Lookups only READ.
 *
 * Keyed by the registration's context — the one object every module of a
 * registration shares — so the registry needs no global and two callers
 * never see each other's lookups.
 */

import type { MCPToolContext } from './common';
import type { Args, Names } from './previews/card';

export type PreviewLookup = (args: Args) => Promise<Names>;

const LOOKUP_TIMEOUT_MS = 4000;

const registry = new WeakMap<MCPToolContext, Map<string, PreviewLookup>>();

export function registerPreviewLookups(
  context: MCPToolContext,
  lookups: Readonly<Record<string, PreviewLookup>>
): void {
  const known = registry.get(context) ?? new Map<string, PreviewLookup>();
  for (const [tool, lookup] of Object.entries(lookups)) known.set(tool, lookup);
  registry.set(context, known);
}

/** The names a tool's lookup finds for these arguments; {} when there is none or it fails. */
export async function lookupNames(
  context: MCPToolContext | undefined,
  tool: string,
  args: Args
): Promise<Names> {
  const lookup = context ? registry.get(context)?.get(tool) : undefined;
  if (!lookup) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(args),
      new Promise<Names>((resolve) => {
        timer = setTimeout(() => resolve({}), LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}
