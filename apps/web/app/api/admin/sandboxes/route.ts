/**
 * Org-admin configuration of where the organization's sandboxes are made
 * — an Azure Container Apps sandbox group or a Docker engine — and what
 * each is started with. GET reports the settings and which secrets are
 * stored; no secret's value ever leaves the server.
 */

import { NextRequest, NextResponse } from 'next/server';
import { parseOrchestratorInput } from '@renkei/sandbox-client';
import { recordAuditEvent } from '@/lib/audit-events';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { isInputProblem, readSandboxes, saveSandboxes } from '@/lib/sandboxes-admin';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

const COMPONENT = 'api/admin/sandboxes';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const view = await readSandboxes();
  if (view === 'ERROR') {
    logger.error('{actor} opened the sandbox setup, but it could not be read; the page got a 500', {
      component: COMPONENT,
      ...who(access),
    });
    return NextResponse.json({ error: 'Could not read the sandbox setup' }, { status: 500 });
  }
  return NextResponse.json(view);
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const input = parseOrchestratorInput(await request.json().catch(() => null));
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });
  const saved = await saveSandboxes(input);
  if (typeof saved === 'string') {
    const theirs = isInputProblem(saved);
    if (!theirs) {
      logger.error('{actor} saved the sandbox setup, but it was not saved: {error}', {
        component: COMPONENT,
        ...who(access),
        error: saved,
      });
    }
    return NextResponse.json({ error: saved }, { status: theirs ? 400 : 500 });
  }
  const { settings } = input;
  recordAuditEvent({
    actorSubject: access.subject,
    action: 'sandboxes.configured',
    targetKind: 'settings',
    targetLabel: 'sandboxes',
    // Where sandboxes are made and the names of what they are started with — never a value.
    details: {
      enabled: input.enabled,
      provider: settings.provider,
      ...(settings.provider === 'azure'
        ? {
            subscriptionId: settings.azure.subscriptionId,
            resourceGroup: settings.azure.resourceGroup,
            sandboxGroup: settings.azure.sandboxGroup,
            portAuth: settings.azure.portAuth,
          }
        : { image: settings.docker.image, nestedEngine: settings.docker.nestedEngine }),
      idleSuspendMinutes: settings.idleSuspendMinutes,
      idleEvictHours: settings.idleEvictHours,
      envNames: settings.envNames,
    },
  });
  return NextResponse.json(saved);
}
