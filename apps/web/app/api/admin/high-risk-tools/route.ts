/**
 * The organization's locked high-risk tools (@renkei/settings'
 * lockedHighRiskTools): read and replaced whole by the Settings page's
 * "Locked high-risk tools" card. Operators only.
 *
 * A locked tool is high risk for everyone whatever their own lists say:
 * an agent batch holding one waits for a person, a code project's Auto
 * mode asks before it, and no chat can be told to always allow it. So the
 * write is audited with what was added and what was taken off, the same
 * way the settings route records the knobs it turns.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import { getOrgSettings, setOrgSettings } from '@renkei/settings';
import { isToolName } from '@renkei/user-prefs/prefs';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

/** A typo guard: the whole catalog is a few hundred act tools. */
const MAX_LOCKED = 2_000;

export async function GET(): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const settings = await getOrgSettings();
  if (!settings.ok) {
    return NextResponse.json({ error: 'Could not read org settings' }, { status: 500 });
  }
  return NextResponse.json({ tools: settings.val.lockedHighRiskTools });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const raw = isRecord(body) ? body.tools : undefined;
  if (!Array.isArray(raw) || raw.length > MAX_LOCKED || !raw.every(isToolName)) {
    return NextResponse.json(
      { error: `tools must be a list of at most ${MAX_LOCKED} tool names` },
      { status: 400 }
    );
  }
  const tools = [...new Set<string>(raw)].sort();

  const current = await getOrgSettings();
  if (!current.ok) {
    logger.error(
      "{actor} changed the organization's locked high-risk tools, but the current list could not be read; nothing was saved: {error}",
      {
        component: 'api/admin/high-risk-tools',
        ...who(access),
        error: current.err.message ?? current.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not read org settings' }, { status: 500 });
  }
  const before = new Set(current.val.lockedHighRiskTools);
  const after = new Set(tools);
  const added = tools.filter((tool) => !before.has(tool));
  const removed = [...before].filter((tool) => !after.has(tool)).sort();

  if (added.length > 0 || removed.length > 0) {
    const saved = await setOrgSettings({ lockedHighRiskTools: tools });
    if (!saved.ok) {
      logger.error(
        "{actor} changed the organization's locked high-risk tools, but the list was not saved: {error}",
        {
          component: 'api/admin/high-risk-tools',
          ...who(access),
          added,
          removed,
          error: saved.err.message ?? saved.err.type,
        }
      );
      return NextResponse.json({ error: 'Could not save the list' }, { status: 500 });
    }
    recordAuditEvent({
      actorSubject: access.subject,
      action: 'settings.updated',
      targetKind: 'settings',
      details: { changed: { lockedHighRiskTools: { added, removed } } },
    });
    logger.info(
      "{actor} changed the organization's locked high-risk tools: {addedCount} locked, {removedCount} unlocked",
      {
        component: 'api/admin/high-risk-tools',
        ...who(access),
        added,
        removed,
        addedCount: added.length,
        removedCount: removed.length,
      }
    );
  }
  return NextResponse.json({ tools });
}
