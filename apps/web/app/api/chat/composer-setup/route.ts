/**
 * What a composer needs that a page would otherwise hand it: the models to
 * pick from, whether files can be attached, the mass-upload threshold, and
 * the person's voice set-up (null when the org has no voice service).
 * Read by the quick-chat box, which opens on any page and so has no thread
 * page to carry them.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { tenantBlobStoreConfigured } from '@renkei/blob-store';
import { getOrgSettings } from '@renkei/settings';
import { chatRequestContext } from '@/lib/chat/route-support';
import { listChatModels } from '@/lib/chat/models';
import { loadVoiceAvailability } from '@/lib/voice/availability';

export async function GET(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const [models, uploadsEnabled, voice, orgSettings] = await Promise.all([
    listChatModels(),
    tenantBlobStoreConfigured(),
    loadVoiceAvailability(session.subject),
    getOrgSettings(),
  ]);
  return NextResponse.json({
    models,
    uploadsEnabled,
    massUploadThreshold: orgSettings.ok ? orgSettings.val.massUploadThreshold : 10,
    voice,
  });
}
