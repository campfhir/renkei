/**
 * Org-admin configuration of the web-search connector — the Azure OpenAI
 * (or OpenAI) Responses API deployment whose built-in `web_search` tool
 * answers `web_search` calls. Same shape as embeddings/route.ts and
 * mistral-ocr/route.ts: one org-wide endpoint + deployment + API key, no
 * OAuth. GET reports presence only; the API key never leaves the server.
 * See lib/mcp-tools/web-search/config.ts for the settings/secrets keys this
 * mirrors — resolveWebSearchConfig reads this same connector_configs row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { parseEncryptionKey } from '@renkei/crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
} from '@renkei/connector-config';
import {
  WEB_SEARCH_CONNECTOR,
  MAX_DOMAIN_LIST,
  REASONING_EFFORTS,
  normalizeDomain,
  parseDomainList,
  parseLocation,
  parseReasoningEffort,
} from '@/lib/mcp-tools/web-search/config';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function settingString(settings: Record<string, unknown> | undefined, key: string): string | null {
  const value = settings?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const configResult = await getConnectorConfig(tenantRef.id, WEB_SEARCH_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Could not read connector config' }, { status: 500 });
  }

  const config = configResult.val;
  const settings = config?.settings;
  return NextResponse.json({
    connector: WEB_SEARCH_CONNECTOR,
    configured: config !== null,
    enabled: config?.enabled ?? false,
    baseUrl: settingString(settings, 'baseUrl'),
    model: settingString(settings, 'model'),
    apiVersion: settingString(settings, 'apiVersion'),
    reasoningEffort: parseReasoningEffort(settings?.reasoningEffort),
    userLocation: parseLocation(settings?.userLocation),
    allowedDomains: parseDomainList(settings?.allowedDomains),
    blockedDomains: parseDomainList(settings?.blockedDomains),
    hasApiKey: Boolean(config?.secrets.apiKey),
  });
}

/** Every submitted domain must normalize; a silently dropped entry would narrow a search unseen. */
function validateDomains(
  value: unknown,
  field: string
): { ok: true; domains: string[] } | { ok: false; error: string } {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  const entries = raw.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim() !== ''
  );
  const bad = entries.filter((entry) => normalizeDomain(entry) === null);
  if (bad.length > 0) {
    return { ok: false, error: `${field}: not a hostname — ${bad.slice(0, 5).join(', ')}` };
  }
  const domains = parseDomainList(entries);
  if (entries.length > MAX_DOMAIN_LIST) {
    return { ok: false, error: `${field}: at most ${MAX_DOMAIN_LIST} domains` };
  }
  return { ok: true, domains };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const { baseUrl, model, apiKey } = body;
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return NextResponse.json({ error: 'baseUrl is required' }, { status: 400 });
  }
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl.trim());
  } catch {
    return NextResponse.json({ error: 'baseUrl must be an absolute URL' }, { status: 400 });
  }
  if (parsedBase.protocol !== 'https:' && parsedBase.protocol !== 'http:') {
    return NextResponse.json({ error: 'baseUrl must be an http(s) URL' }, { status: 400 });
  }
  if (typeof model !== 'string' || !model.trim()) {
    return NextResponse.json({ error: 'model is required' }, { status: 400 });
  }
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;
  const apiVersion = typeof body.apiVersion === 'string' ? body.apiVersion.trim() : '';

  const rawEffort = typeof body.reasoningEffort === 'string' ? body.reasoningEffort.trim() : '';
  if (rawEffort && !REASONING_EFFORTS.some((known) => known === rawEffort)) {
    return NextResponse.json(
      { error: `reasoningEffort must be one of ${REASONING_EFFORTS.join(', ')}, or blank` },
      { status: 400 }
    );
  }

  // The location is validated field by field: a country that is not two
  // letters is rejected rather than silently dropped, since "US" vs "USA"
  // is exactly the typo an admin cannot see once the form reloads.
  const rawLocation = isRecord(body.userLocation) ? body.userLocation : {};
  const country = typeof rawLocation.country === 'string' ? rawLocation.country.trim() : '';
  if (country && !/^[A-Za-z]{2}$/.test(country)) {
    return NextResponse.json(
      { error: 'userLocation.country must be a two-letter ISO country code' },
      { status: 400 }
    );
  }
  const userLocation = parseLocation(rawLocation);

  const allowed = validateDomains(body.allowedDomains, 'allowedDomains');
  if (!allowed.ok) return NextResponse.json({ error: allowed.error }, { status: 400 });
  const blocked = validateDomains(body.blockedDomains, 'blockedDomains');
  if (!blocked.ok) return NextResponse.json({ error: blocked.error }, { status: 400 });

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // Secrets survive settings-only saves: setConnectorConfig replaces secrets
  // wholesale, so a blank/omitted secret is merged with the stored one here.
  // A key is required only when none is stored yet.
  const existing = await getConnectorConfig(tenantRef.id, WEB_SEARCH_CONNECTOR, keyResult.val);
  const storedSecrets = existing.ok && existing.val ? existing.val.secrets : {};
  const mergedApiKey = typeof apiKey === 'string' && apiKey ? apiKey : storedSecrets.apiKey;
  if (!mergedApiKey) {
    return NextResponse.json({ error: 'apiKey is required (none stored yet)' }, { status: 400 });
  }

  const writeResult = await setConnectorConfig(
    tenantRef.id,
    WEB_SEARCH_CONNECTOR,
    {
      enabled,
      settings: {
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiVersion,
        reasoningEffort: rawEffort,
        userLocation: userLocation ?? {},
        allowedDomains: allowed.domains,
        blockedDomains: blocked.domains,
      },
      secrets: { apiKey: mergedApiKey },
    },
    keyResult.val
  );
  if (!writeResult.ok) {
    return NextResponse.json({ error: 'Could not store connector config' }, { status: 500 });
  }

  invalidateConnectorConfigCache(tenantRef.id, WEB_SEARCH_CONNECTOR);
  return NextResponse.json({ connector: WEB_SEARCH_CONNECTOR, configured: true, enabled });
}
