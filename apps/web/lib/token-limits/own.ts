/**
 * One person's own standing against the token limits, as the limits card
 * on My usage shows it: plain numbers and ISO instants, so it crosses to
 * the client as it is.
 */

import { getDataStore } from '@renkei/db';
import {
  getOrgSettings,
  getTokenLimitStatus,
  policyLimitsAnything,
  tokenLimitBlock,
  tokenLimitPolicy,
} from '@renkei/settings';
import { limitReachedNote } from './format';

export interface OwnPeriodLimit {
  used: number;
  /** The organization's limit; null when it sets none for this period. */
  limit: number | null;
  boost: number;
  resetsAt: string;
}

export interface OwnModelLimit {
  id: string;
  label: string;
  week: { used: number; limit: number | null };
  month: { used: number; limit: number | null };
}

export interface OwnTokenLimits {
  /** No limit applies to this person. */
  exempt: boolean;
  week: OwnPeriodLimit;
  month: OwnPeriodLimit;
  /** The models the organization limits by themselves, by label. */
  models: OwnModelLimit[];
  /** A limit on everything is reached: no new chat turn or agent run starts. */
  stopped: boolean;
}

/**
 * For each of `modelIds`, why `subject` cannot start a turn on it now, for
 * the model picker; a model they can use has no entry. Empty when the
 * organization limits nothing, the person is exempt, or the limits could
 * not be read (the picker then offers everything, and the turn's own check
 * decides).
 */
export async function modelLimitNotes(
  subject: string,
  modelIds: readonly string[]
): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  const settings = await getOrgSettings();
  if (!settings.ok || !policyLimitsAnything(tokenLimitPolicy(settings.val))) return notes;
  const status = await getTokenLimitStatus(subject);
  if (!status.ok) return notes;
  for (const modelId of modelIds) {
    const block = tokenLimitBlock(status.val, modelId);
    if (block) {
      notes.set(
        modelId,
        limitReachedNote({
          period: block.period,
          llmModelId: block.llmModelId,
          resetsAt: block.resetsAt.toISOString(),
        })
      );
    }
  }
  return notes;
}

/** Null when it could not be read; the card is then left out. */
export async function readOwnTokenLimits(subject: string): Promise<OwnTokenLimits | null> {
  const status = await getTokenLimitStatus(subject);
  if (!status.ok) return null;
  const { week, month, models, exempt } = status.val;
  let labels = new Map<string, string>();
  if (models.length > 0) {
    try {
      labels = new Map((await getDataStore().llmModels.list()).map((m) => [m.id, m.label]));
    } catch {
      return null;
    }
  }
  return {
    exempt,
    week: {
      used: week.used,
      limit: week.limit,
      boost: week.boost,
      resetsAt: week.resetsAt.toISOString(),
    },
    month: {
      used: month.used,
      limit: month.limit,
      boost: month.boost,
      resetsAt: month.resetsAt.toISOString(),
    },
    models: models
      // A limit left behind by a deleted model limits nothing anyone can pick.
      .filter((model) => labels.has(model.llmModelId))
      .map((model) => ({
        id: model.llmModelId,
        label: labels.get(model.llmModelId) ?? model.llmModelId,
        week: model.week,
        month: model.month,
      }))
      .sort((a, b) => a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1)),
    stopped: tokenLimitBlock(status.val, null) !== null,
  };
}

/** Whether there is anything for the card to say. */
export function hasTokenLimits(limits: OwnTokenLimits | null): limits is OwnTokenLimits {
  if (!limits) return false;
  return (
    limits.exempt ||
    limits.week.limit !== null ||
    limits.month.limit !== null ||
    limits.models.length > 0
  );
}
