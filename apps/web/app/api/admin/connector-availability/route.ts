/**
 * Org-admin switching of connectors on and off.
 *
 * Distinct from the three neighbouring controls, and the distinction is the
 * reason this route exists:
 *
 *   connector_configs.enabled  stops new CONNECTIONS. Already-connected users
 *                              keep working, so it is not an off switch.
 *   the scope ceiling          narrows what a user may consent to, and taking
 *                              a capability back means every connected user
 *                              must reconnect to get it again.
 *   disabledConnectors (here)  stops the TOOLS being registered, org-wide and
 *                              immediately, touching nobody's grant. Flipping
 *                              it back restores everything with no user
 *                              action at all.
 *
 * That last property is what makes this the right control for "turn this off
 * for now" — the others are provisioning decisions wearing the same clothes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getOrgSettings, setOrgSettings } from '@renkei/settings';
import { togglableConnectors } from '@/lib/connector-catalog';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const settings = await getOrgSettings();
  if (!settings.ok) {
    logger.error(
      '{actor} opened the connector on/off switches, but the org settings could not be read; the page got a 500: {error}',
      {
        component: 'api/admin/connector-availability',
        ...who(session),
        error: settings.err.message ?? settings.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not read org settings' }, { status: 500 });
  }
  return NextResponse.json({ disabledConnectors: settings.val.disabledConnectors });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const submitted = 'disabledConnectors' in body ? body.disabledConnectors : undefined;
  if (!Array.isArray(submitted)) {
    return NextResponse.json({ error: 'disabledConnectors must be an array' }, { status: 400 });
  }

  // Only keys the catalog knows about. An unrecognised key would sit in the
  // settings row disabling nothing, which reads as "I turned it off and it
  // stayed on" — worse than a rejection.
  const known = new Set(togglableConnectors().map((entry) => entry.capabilityKey));
  const disabledConnectors = [
    ...new Set(
      submitted.filter((entry): entry is string => typeof entry === 'string' && known.has(entry))
    ),
  ];

  const saved = await setOrgSettings({ disabledConnectors });
  if (!saved.ok) {
    logger.error(
      '{actor} set the switched-off connectors to "{disabled}", but the org settings were not saved; nothing changed: {error}',
      {
        component: 'api/admin/connector-availability',
        ...who(session),
        disabledConnectors,
        disabled: disabledConnectors.join(', ') || 'none',
        error: saved.err.message ?? saved.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not save org settings' }, { status: 500 });
  }
  // Org-wide, not one caller's own — every cached catalog in this tenant
  // may now be wrong about which tools are registered.
  invalidateToolCatalogCache();
  return NextResponse.json({ disabledConnectors });
}
