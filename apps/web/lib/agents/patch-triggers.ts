/**
 * Editing an agent's triggers without resending the whole definition.
 *
 * `agent_update` REPLACES what is stored, which makes the trigger list an
 * all-or-nothing echo: to retime a schedule you must send every other
 * trigger back verbatim, and one you forget is not left alone — it is
 * DELETED, along with its firing history, its computed next run and, for an
 * API trigger, a key that can never be shown again. `agent_patch_steps`
 * already refused that bargain for steps; triggers carry more irrecoverable
 * state than steps do, so they need the same primitive.
 *
 * A patch names the trigger it changes by id (from `agent_get`) and leaves
 * every other one alone by construction.
 *
 * ## Ids are the anchor, and kinds are fixed
 *
 * `reconcileTriggers` matches a payload id to a row only when the KIND also
 * matches, and treats a mismatch as a new trigger — the old row is dropped
 * and a new one inserted. That is the right rule for the builder (ids are
 * its bookkeeping) and a trap for a caller who thinks they are editing a
 * trigger in place, so an `update` that changes a trigger's kind is refused
 * here rather than quietly becoming a delete-and-recreate.
 */

import { isTriggerDraft, triggerDraftIssue, type TriggerDraft } from '@renkei/agents';
import type { TriggerPayload } from '@/lib/agents/store';

export type TriggerOperation =
  /** Append a trigger; the server mints its id (and any API key). */
  | { op: 'add'; draft: TriggerDraft; enabled: boolean }
  /** Change the draft and/or the on/off state of one trigger, id kept. */
  | { op: 'update'; id: string; draft?: TriggerDraft; enabled?: boolean }
  | { op: 'remove'; id: string };

/** What the patch starts from — the agent's triggers as stored. */
export interface ExistingTrigger {
  id: string;
  draft: TriggerDraft;
  enabled: boolean;
}

export type TriggerPatchResult =
  { ok: true; triggers: TriggerPayload[] } | { ok: false; error: string };

/** The ids a caller could have meant, so a typo answers itself. */
function knownIds(triggers: TriggerPayload[]): string {
  const named = triggers.filter((trigger) => trigger.id !== undefined);
  if (named.length === 0) return 'this agent has no triggers yet';
  return `this agent's triggers are ${named
    .map((trigger) => `"${trigger.id}" (${trigger.draft.kind})`)
    .join(', ')}`;
}

/**
 * Apply operations in order, stopping at the first that cannot be applied.
 *
 * All-or-nothing, like the steps patch: a half-applied trigger patch leaves
 * an agent firing on a schedule nobody described, and the caller would have
 * to diff to find out which operations took.
 */
export function applyTriggerPatch(
  existing: ExistingTrigger[],
  operations: TriggerOperation[]
): TriggerPatchResult {
  if (operations.length === 0) return { ok: false, error: 'no operations were given' };

  // Ids ride through untouched: firings, the computed next run and an API
  // trigger's key hash all anchor to the row they name.
  let triggers: TriggerPayload[] = existing.map((trigger) => ({
    id: trigger.id,
    draft: trigger.draft,
    enabled: trigger.enabled,
  }));

  for (const [ordinal, operation] of operations.entries()) {
    const label = `operation ${ordinal + 1} (${operation.op})`;
    if (operation.op === 'add') {
      triggers = [...triggers, { draft: operation.draft, enabled: operation.enabled }];
      continue;
    }

    const at = triggers.findIndex((trigger) => trigger.id === operation.id);
    if (at === -1) {
      return {
        ok: false,
        error:
          `${label}: no trigger with id "${operation.id}" — ${knownIds(triggers)}. ` +
          'Ids come from agent_get.',
      };
    }
    if (operation.op === 'remove') {
      triggers = triggers.filter((_, index) => index !== at);
      continue;
    }

    const current = triggers[at];
    if (!current) continue;
    if (operation.draft === undefined && operation.enabled === undefined) {
      return { ok: false, error: `${label}: give a "draft", an "enabled", or both` };
    }
    if (operation.draft && operation.draft.kind !== current.draft.kind) {
      // reconcileTriggers would take this as a new trigger and drop the old
      // row, which is a delete the caller did not ask for.
      return {
        ok: false,
        error:
          `${label}: trigger "${operation.id}" is a ${current.draft.kind} trigger, and a ` +
          `${operation.draft.kind} draft is a different trigger — remove it and add the new ` +
          'one, knowing its firings and any API key do not carry over',
      };
    }
    const next: TriggerPayload = {
      id: current.id,
      draft: operation.draft ?? current.draft,
      enabled: operation.enabled ?? current.enabled,
    };
    triggers = triggers.map((trigger, index) => (index === at ? next : trigger));
  }

  return { ok: true, triggers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Wire operations into typed ones, refusing anything malformed by NAME.
 *
 * A rejected draft carries `triggerDraftIssue`'s reason — the whole point of
 * naming the offending key and its accepted values is that a caller writing
 * a schedule by hand gets it on the first attempt, and a patch is where they
 * will be writing one.
 */
export function toTriggerOperations(
  value: unknown
): { val: TriggerOperation[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'triggers must be a non-empty array of operations' };
  }
  const out: TriggerOperation[] = [];
  for (const [ordinal, raw] of value.entries()) {
    const label = `operation ${ordinal + 1}`;
    if (!isRecord(raw)) return { error: `${label}: not an object` };
    const op = raw.op;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : undefined;
    const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : undefined;

    if (op === 'add' || op === 'update') {
      if (raw.draft !== undefined && !isTriggerDraft(raw.draft)) {
        return { error: `${label} (${op}): ${triggerDraftIssue(raw.draft)}` };
      }
      if (op === 'add') {
        if (raw.draft === undefined) {
          return { error: `${label} (add): a "draft" is required — a new trigger has no id yet` };
        }
        // A trigger added without saying otherwise is meant to fire: the
        // agent's own enabled flag is what decides whether it runs at all.
        out.push({ op, draft: raw.draft, enabled: enabled ?? true });
        continue;
      }
      if (!id) return { error: `${label} (update): id is required — take it from agent_get` };
      out.push({
        op,
        id,
        ...(raw.draft !== undefined ? { draft: raw.draft } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      });
      continue;
    }
    if (op === 'remove') {
      if (!id) return { error: `${label} (remove): id is required — take it from agent_get` };
      out.push({ op, id });
      continue;
    }
    return {
      error:
        `${label}: op must be "add", "update" or "remove"` +
        ('kind' in raw
          ? ' — a bare trigger draft goes in an operation\'s "draft", e.g. ' +
            '{op:"update", id:"<from agent_get>", draft:{kind:"schedule", ...}}'
          : ''),
    };
  }
  return { val: out };
}
