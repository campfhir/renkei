/**
 * Prepare the sandbox disk image again: an operator's ask from
 * Organization → Sandboxes after the orchestrator could not have the
 * group build the image for its release. The orchestrator starts the
 * build (or joins one under way) and puts sandboxes in force once it is
 * Ready; this answers the setup as the page shows it, with where the
 * build is now.
 */

import { NextRequest, NextResponse } from 'next/server';
import { recordAuditEvent } from '@/lib/audit-events';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { prepareSandboxesImage } from '@/lib/sandboxes-admin';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

const COMPONENT = 'api/admin/sandboxes/prepare-image';

export async function POST(_request: NextRequest): Promise<NextResponse> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const view = await prepareSandboxesImage();
  if (view === 'ERROR') {
    logger.error(
      '{actor} asked for the sandbox disk image to be prepared again, but the setup could not be read back; the page got a 500',
      { component: COMPONENT, ...who(access) }
    );
    return NextResponse.json({ error: 'Could not read the sandbox setup' }, { status: 500 });
  }
  const image = view.orchestrator.image ?? null;
  recordAuditEvent({
    actorSubject: access.subject,
    action: 'sandboxes.image_prepared',
    targetKind: 'settings',
    targetLabel: 'sandboxes',
    details: { build: image?.build ?? null, state: image?.state ?? null },
  });
  logger.info(
    '{actor} asked for the sandbox disk image for build {build} to be prepared again; it is {state}',
    {
      component: COMPONENT,
      ...who(access),
      build: image?.build ?? 'unknown',
      state: image?.state ?? 'not prepared by the orchestrator',
    }
  );
  return NextResponse.json(view);
}
