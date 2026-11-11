/**
 * What the Token limits page shows an operator: the organization's limits,
 * the models a limit can be put on, and every person with what they have
 * used this week and this month, whether they are exempt, and the boosts
 * they hold. One read for the page and for each route's answer, so the
 * screen always redraws from what is stored.
 */

import { getDataStore } from '@renkei/db';
import {
  getOrgSettings,
  tokenLimitPeriods,
  tokenLimitPolicy,
  type TokenLimitPolicy,
} from '@renkei/settings';

export interface TokenLimitBoostView {
  id: string;
  period: 'week' | 'month';
  tokens: number;
  /** ISO instant the boost's period ends. */
  expiresAt: string;
  note: string | null;
}

export interface TokenLimitPersonView {
  subject: string;
  name: string;
  email: string;
  exempt: boolean;
  weekUsed: number;
  monthUsed: number;
  boosts: TokenLimitBoostView[];
}

export interface TokenLimitModelView {
  id: string;
  label: string;
  enabled: boolean;
}

export interface TokenLimitAdminView {
  policy: TokenLimitPolicy;
  /** ISO instants. */
  weekResetsAt: string;
  monthResetsAt: string;
  models: TokenLimitModelView[];
  people: TokenLimitPersonView[];
}

/** Null when the settings or the store could not be read. */
export async function readTokenLimitAdminView(
  now: Date = new Date()
): Promise<TokenLimitAdminView | null> {
  const settings = await getOrgSettings();
  if (!settings.ok) return null;
  const policy = tokenLimitPolicy(settings.val);
  const periods = tokenLimitPeriods(policy, now);
  const store = getDataStore();
  try {
    const [identities, exempt, boosts, weekSpend, monthSpend, models] = await Promise.all([
      store.identities.list(),
      store.tokenLimits.listExempt(),
      store.tokenLimits.activeBoosts(now),
      store.tokenLimits.spentBySubjectSince(periods.week.startsAt),
      store.tokenLimits.spentBySubjectSince(periods.month.startsAt),
      store.llmModels.list(),
    ]);
    const exemptSubjects = new Set(exempt.map((row) => row.subject));
    const week = new Map(weekSpend.map((row) => [row.subject, row.tokens]));
    const month = new Map(monthSpend.map((row) => [row.subject, row.tokens]));
    const people = identities
      .map((identity) => ({
        subject: identity.subject,
        name: identity.displayName || identity.email || identity.subject,
        email: identity.email,
        exempt: exemptSubjects.has(identity.subject),
        weekUsed: week.get(identity.subject) ?? 0,
        monthUsed: month.get(identity.subject) ?? 0,
        boosts: boosts
          .filter((boost) => boost.subject === identity.subject)
          .map((boost) => ({
            id: boost.id,
            period: boost.period,
            tokens: boost.tokens,
            expiresAt: boost.expiresAt.toISOString(),
            note: boost.note,
          })),
      }))
      // Who is spending most this month first; then by name, then subject.
      .sort(
        (a, b) =>
          b.monthUsed - a.monthUsed ||
          a.name.localeCompare(b.name) ||
          (a.subject < b.subject ? -1 : 1)
      );
    return {
      policy,
      weekResetsAt: periods.week.resetsAt.toISOString(),
      monthResetsAt: periods.month.resetsAt.toISOString(),
      models: models.map((model) => ({
        id: model.id,
        label: model.label,
        enabled: model.enabled,
      })),
      people,
    };
  } catch {
    return null;
  }
}
