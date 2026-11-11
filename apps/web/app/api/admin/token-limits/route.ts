/**
 * The organization's token limits: the most tokens one person may spend in
 * a week and in a month (their agents included), when and in which time
 * zone the week resets, and
 * limits on single models. Read and written here for the Token limits page;
 * a person's exemption and boosts are the routes beside this one.
 *
 * A PUT carries only what changed. Model limits are patched per model
 * (`models: { <id>: { weekly, monthly } }`, or null to take a model's limit
 * away), so two operators setting different models do not undo each other.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import { getDataStore } from '@renkei/db';
import {
  getOrgSettings,
  isTimeZone,
  setOrgSettings,
  type ModelTokenLimit,
  type OrgSettings,
} from '@renkei/settings';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { recordAuditEvent } from '@/lib/audit-events';
import { readTokenLimitAdminView } from '@/lib/token-limits/admin';
import { isUuid } from '@/lib/uuid';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

/** A trillion tokens: far past any real limit, and safely a whole number. */
const MAX_TOKENS = 1_000_000_000_000;

const NUMERIC = {
  weekly: ['tokenLimitWeekly', 0, MAX_TOKENS],
  monthly: ['tokenLimitMonthly', 0, MAX_TOKENS],
  weekResetDay: ['tokenLimitWeekResetDay', 0, 6],
  weekResetMinute: ['tokenLimitWeekResetMinute', 0, 1439],
} as const;

function wholeNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export async function GET(): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const view = await readTokenLimitAdminView();
  if (!view) {
    logger.error(
      '{actor} opened the token limits, but they could not be read; the page got a 500',
      { component: 'api/admin/token-limits', ...who(session) }
    );
    return NextResponse.json({ error: 'Could not read the token limits' }, { status: 500 });
  }
  return NextResponse.json(view);
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) return NextResponse.json({ error: 'JSON body required' }, { status: 400 });

  const current = await getOrgSettings();
  if (!current.ok) {
    logger.error(
      '{actor} saved the token limits, but the current ones could not be read; nothing was saved: {error}',
      {
        component: 'api/admin/token-limits',
        ...who(session),
        error: current.err.message ?? current.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not read the token limits' }, { status: 500 });
  }

  const updates: Partial<OrgSettings> = {};
  const changed: Record<string, { from: unknown; to: unknown }> = {};

  for (const [field, [key, min, max]] of Object.entries(NUMERIC)) {
    if (!(field in body)) continue;
    const value = wholeNumber(body[field], min, max);
    if (value === null) {
      return NextResponse.json({ error: `${field} must be a number` }, { status: 400 });
    }
    if (value !== current.val[key]) {
      updates[key] = value;
      changed[field] = { from: current.val[key], to: value };
    }
  }

  // A month holds at least a week: 0 is no limit, so only two real limits can conflict.
  const weeklyAfter = updates.tokenLimitWeekly ?? current.val.tokenLimitWeekly;
  const monthlyAfter = updates.tokenLimitMonthly ?? current.val.tokenLimitMonthly;
  if (weeklyAfter > 0 && monthlyAfter > 0 && monthlyAfter < weeklyAfter) {
    return NextResponse.json(
      { error: 'The monthly limit must be at least the weekly limit' },
      { status: 400 }
    );
  }

  if ('timeZone' in body) {
    // An IANA name this server's Intl knows: the resets are computed here.
    if (!isTimeZone(body.timeZone)) {
      return NextResponse.json({ error: 'timeZone must be a time zone name' }, { status: 400 });
    }
    if (body.timeZone !== current.val.tokenLimitTimeZone) {
      updates.tokenLimitTimeZone = body.timeZone;
      changed.timeZone = { from: current.val.tokenLimitTimeZone, to: body.timeZone };
    }
  }

  if ('models' in body) {
    if (!isRecord(body.models)) {
      return NextResponse.json({ error: 'models must be an object' }, { status: 400 });
    }
    const known = new Set((await getDataStore().llmModels.list()).map((model) => model.id));
    const next: Record<string, ModelTokenLimit> = { ...current.val.modelTokenLimits };
    for (const [modelId, value] of Object.entries(body.models)) {
      if (!isUuid(modelId)) {
        return NextResponse.json({ error: 'models is keyed by model id' }, { status: 400 });
      }
      const before = next[modelId] ?? null;
      let after: ModelTokenLimit | null = null;
      if (value !== null) {
        if (!isRecord(value)) {
          return NextResponse.json(
            { error: 'A model limit is { weekly, monthly }, or null to remove it' },
            { status: 400 }
          );
        }
        const weekly = wholeNumber(value.weekly ?? 0, 0, MAX_TOKENS);
        const monthly = wholeNumber(value.monthly ?? 0, 0, MAX_TOKENS);
        if (weekly === null || monthly === null) {
          return NextResponse.json(
            { error: 'A model limit is two numbers of tokens' },
            { status: 400 }
          );
        }
        if (weekly > 0 && monthly > 0 && monthly < weekly) {
          return NextResponse.json(
            { error: 'A model’s monthly limit must be at least its weekly limit' },
            { status: 400 }
          );
        }
        // Both zero limits nothing, which is the same as no entry.
        after = weekly === 0 && monthly === 0 ? null : { weekly, monthly };
      }
      if (after !== null && !known.has(modelId)) {
        return NextResponse.json({ error: 'No such model' }, { status: 404 });
      }
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (after === null) delete next[modelId];
      else next[modelId] = after;
      changed[`models.${modelId}`] = { from: before, to: after };
    }
    // A model that was deleted takes its limit with it the next time limits are saved.
    for (const modelId of Object.keys(next)) {
      if (!known.has(modelId)) delete next[modelId];
    }
    if (JSON.stringify(next) !== JSON.stringify(current.val.modelTokenLimits)) {
      updates.modelTokenLimits = next;
    }
  }

  if (Object.keys(updates).length > 0) {
    const saved = await setOrgSettings(updates);
    if (!saved.ok) {
      logger.error('{actor} changed the token limits ({keys}), but they were not saved: {error}', {
        component: 'api/admin/token-limits',
        ...who(session),
        keys: Object.keys(changed).join(', '),
        changed,
        error: saved.err.message ?? saved.err.type,
      });
      return NextResponse.json({ error: 'Could not save the token limits' }, { status: 500 });
    }
    recordAuditEvent({
      actorSubject: session.subject,
      action: 'token_limits.updated',
      targetKind: 'settings',
      details: { changed },
    });
    logger.info('{actor} changed the token limits: {keys}', {
      component: 'api/admin/token-limits',
      ...who(session),
      keys: Object.keys(changed).join(', '),
      changed,
    });
  }

  const view = await readTokenLimitAdminView();
  if (!view) {
    return NextResponse.json(
      { error: 'Saved, but the limits could not be read back' },
      { status: 500 }
    );
  }
  return NextResponse.json(view);
}
