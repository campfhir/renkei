/**
 * The org settings that have no more specific home. Connector switches live
 * on the connectors page, redaction on its own page, run retention on agent
 * oversight — everything else (read-only mode, agent guardrails, token
 * lifetimes, request limits) is read and written here for the settings page.
 *
 * Every numeric setting is clamped to a stated range rather than trusted:
 * these values feed guards (rate limits, chain depth, timeouts), and a guard
 * set to zero or a million by typo is a guard removed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getOrgSettings, setOrgSettings, type OrgSettings } from '@renkei/settings';
import { recordAuditEvent } from '@/lib/audit-events';

/** key → [min, max]; the UI states the same ranges. */
const NUMERIC_BOUNDS = {
  maxJqlResults: [1, 1000],
  maxAttachmentBytes: [1_048_576, 104_857_600], // 1MB..100MB
  rateLimitPerUserPerMinute: [1, 10_000],
  accessTokenTtlMinutes: [5, 1_440],
  authorizationCodeTtlSeconds: [30, 600],
  refreshTokenTtlDays: [1, 365],
  agentMaxChainDepth: [1, 10],
  agentRunTimeoutMinutes: [1, 120],
  // Above the 10 default is allowed on purpose; 100 is the typo guard.
  agentMaxStepAttempts: [1, 100],
  agentMaxRunsPerDay: [1, 10_000],
  // Ceiling on how long an approval node may wait for its owner; 90 days
  // is the typo guard, 1 the floor (a sub-day org bound would make the
  // feature useless).
  agentApprovalMaxWaitDays: [1, 90],
  // Floor 5: the worker's sweep wakes every 5 minutes, so smaller values
  // would promise a freshness the sweep cannot deliver.
  contentPollMinutes: [5, 1_440],
  // 0 = keep forever; a year of logs is the typo guard on the other end.
  logRetentionDays: [0, 3_650],
} as const;

const NUMERIC_KEYS = [
  'maxJqlResults',
  'maxAttachmentBytes',
  'rateLimitPerUserPerMinute',
  'accessTokenTtlMinutes',
  'authorizationCodeTtlSeconds',
  'refreshTokenTtlDays',
  'agentMaxChainDepth',
  'agentRunTimeoutMinutes',
  'agentMaxStepAttempts',
  'agentMaxRunsPerDay',
  'agentApprovalMaxWaitDays',
  'contentPollMinutes',
  'logRetentionDays',
] as const;

const BOOLEAN_KEYS = ['readOnly', 'enableDcr'] as const;

type EditableKey = keyof typeof NUMERIC_BOUNDS | (typeof BOOLEAN_KEYS)[number];

function editable(settings: OrgSettings): Record<EditableKey, boolean | number> {
  return {
    readOnly: settings.readOnly,
    enableDcr: settings.enableDcr,
    maxJqlResults: settings.maxJqlResults,
    maxAttachmentBytes: settings.maxAttachmentBytes,
    rateLimitPerUserPerMinute: settings.rateLimitPerUserPerMinute,
    accessTokenTtlMinutes: settings.accessTokenTtlMinutes,
    authorizationCodeTtlSeconds: settings.authorizationCodeTtlSeconds,
    refreshTokenTtlDays: settings.refreshTokenTtlDays,
    agentMaxChainDepth: settings.agentMaxChainDepth,
    agentRunTimeoutMinutes: settings.agentRunTimeoutMinutes,
    agentMaxStepAttempts: settings.agentMaxStepAttempts,
    agentMaxRunsPerDay: settings.agentMaxRunsPerDay,
    agentApprovalMaxWaitDays: settings.agentApprovalMaxWaitDays,
    contentPollMinutes: settings.contentPollMinutes,
    logRetentionDays: settings.logRetentionDays,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const settings = await getOrgSettings(tenantRef.id);
  if (!settings.ok) {
    return NextResponse.json({ error: 'Could not read org settings' }, { status: 500 });
  }
  return NextResponse.json({ settings: editable(settings.val) });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const submitted: Record<string, unknown> = { ...body };

  const current = await getOrgSettings(tenantRef.id);
  if (!current.ok) {
    return NextResponse.json({ error: 'Could not read org settings' }, { status: 500 });
  }
  const before = editable(current.val);

  const updates: Partial<OrgSettings> = {};
  const changed: Record<string, { from: boolean | number; to: boolean | number }> = {};

  for (const key of BOOLEAN_KEYS) {
    if (!(key in submitted)) continue;
    if (typeof submitted[key] !== 'boolean') {
      return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 });
    }
    if (submitted[key] !== before[key]) {
      updates[key] = submitted[key];
      changed[key] = { from: before[key], to: submitted[key] };
    }
  }

  for (const key of NUMERIC_KEYS) {
    if (!(key in submitted)) continue;
    const [min, max] = NUMERIC_BOUNDS[key];
    const value = submitted[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return NextResponse.json({ error: `${key} must be a number` }, { status: 400 });
    }
    const clamped = Math.min(Math.max(Math.trunc(value), min), max);
    if (clamped !== before[key]) {
      updates[key] = clamped;
      changed[key] = { from: before[key], to: clamped };
    }
  }

  if (Object.keys(updates).length > 0) {
    const saved = await setOrgSettings(tenantRef.id, updates);
    if (!saved.ok) {
      return NextResponse.json({ error: 'Could not save settings' }, { status: 500 });
    }
    recordAuditEvent({
      tenantId: tenantRef.id,
      actorSubject: access.subject,
      action: 'settings.updated',
      targetKind: 'settings',
      // Which knobs and both values: settings are config, not content, and
      // "who set read-only, and when" is precisely an audit question.
      details: { changed },
    });
  }

  const after = await getOrgSettings(tenantRef.id);
  return NextResponse.json({
    settings: after.ok ? editable(after.val) : { ...before, ...updates },
  });
}
