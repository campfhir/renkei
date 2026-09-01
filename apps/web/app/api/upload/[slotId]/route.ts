/**
 * The out-of-band upload endpoint. GET serves a minimal self-contained
 * browser page; POST receives the RAW file bytes for a previously minted
 * slot and forwards them to the slot's destination under the requester's
 * stored grants (lib/upload-executors.ts).
 *
 * Authentication is the slot's opaque bearer in the Authorization header —
 * the slot id in the path is deliberately non-secret. The browser flow
 * carries the token in the URL FRAGMENT (…/{slotId}#token): fragments are
 * never sent to the server, so it appears in no access log; the page's JS
 * lifts it into the Authorization header.
 *
 * Single-use is enforced by the claim UPDATE: pending + unexpired +
 * matching hash flips to 'completed' (busy marker) in one statement — a
 * second POST, a wrong token, and an expired slot all read as 410, on
 * purpose indistinguishable.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { hashUploadToken } from '@/lib/mcp-tools/upload-slots';
import { completeUploadSlot } from '@/lib/upload-executors';
import { logger } from '@/lib/logger';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slotId: string }> }
): Promise<Response> {
  const { slotId } = await params;
  const dbResult = getDatabase();
  const slot = dbResult.ok
    ? await dbResult.val
        .selectFrom('upload_slots')
        .select(['id', 'filename', 'kind', 'status', 'expires_at'])
        .where('id', '=', slotId)
        .executeTakeFirst()
    : undefined;

  // The page renders regardless (a missing slot still explains itself) —
  // but only ever non-secret fields.
  const heading = slot
    ? `Upload “${slot.filename}”`
    : 'Upload link not found';
  const note = !slot
    ? 'This upload link does not exist. Request a new one.'
    : slot.status !== 'pending'
      ? `This upload is already ${slot.status}.`
      : new Date(slot.expires_at).getTime() < Date.now()
        ? 'This upload link has expired. Request a new one.'
        : 'Pick the file and upload. The link is single-use.';
  const disabled = !slot || slot.status !== 'pending';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Renkei upload</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111}
  h1{font-size:1.1rem} button{padding:.5rem 1rem;font-size:1rem;margin-top:1rem}
  #out{margin-top:1rem;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.85rem}
  .err{color:#b91c1c}.ok{color:#15803d}
</style></head><body>
<h1>${heading.replace(/</g, '&lt;')}</h1>
<p>${note}</p>
${disabled ? '' : '<input type="file" id="file"><br><button id="go">Upload</button><div id="out"></div>'}
<script>
  const btn=document.getElementById('go');
  if(btn)btn.addEventListener('click',async()=>{
    const out=document.getElementById('out');
    const token=location.hash.slice(1);
    if(!token){out.textContent='The link is missing its access token fragment (#…). Use the full link you were given.';out.className='err';return}
    const file=document.getElementById('file').files[0];
    if(!file){out.textContent='Pick a file first.';out.className='err';return}
    btn.disabled=true;out.textContent='Uploading…';out.className='';
    try{
      const res=await fetch(location.pathname,{method:'POST',headers:{Authorization:'Bearer '+token},body:file});
      const body=await res.json().catch(()=>({detail:'Unexpected response ('+res.status+')'}));
      out.textContent=body.detail||JSON.stringify(body);
      out.className=res.ok&&body.ok?'ok':'err';
    }catch(e){out.textContent=String(e);out.className='err';btn.disabled=false}
  });
</script>
</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slotId: string }> }
): Promise<Response> {
  const { slotId } = await params;
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) {
    return NextResponse.json(
      { ok: false, detail: 'Send the upload token as: Authorization: Bearer <token>' },
      { status: 401 }
    );
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ ok: false, detail: 'Database unavailable.' }, { status: 500 });
  }
  const db = dbResult.val;

  // Atomic single-use claim; the flip to 'completed' doubles as the busy
  // marker (the executor's outcome overwrites result/status detail below).
  const claimed = await db
    .updateTable('upload_slots')
    .set({ status: 'completed', completed_at: sql`NOW()` })
    .where('id', '=', slotId)
    .where('token_hash', '=', hashUploadToken(token))
    .where('status', '=', 'pending')
    .where('expires_at', '>', sql<Date>`NOW()`)
    .returning([
      'id',
      'tenant_id',
      'subject',
      'account_id',
      'kind',
      'destination',
      'filename',
      'content_type',
      'max_bytes',
    ])
    .executeTakeFirst();
  if (!claimed) {
    // Wrong token, expired, already used, or no such slot — one answer.
    return NextResponse.json(
      { ok: false, detail: 'This upload link is not valid (wrong token, expired, or already used).' },
      { status: 410 }
    );
  }

  const finish = async (ok: boolean, detail: string, status = 200): Promise<Response> => {
    await db
      .updateTable('upload_slots')
      .set({ status: ok ? 'completed' : 'failed', result: detail, completed_at: sql`NOW()` })
      .where('id', '=', claimed.id)
      .execute();
    return NextResponse.json({ ok, detail }, { status });
  };

  // Stream the body with a hard running-total cap — an oversized upload is
  // refused without buffering the remainder.
  const reader = request.body?.getReader();
  if (!reader) return finish(false, 'The request carried no body.', 400);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > claimed.max_bytes) {
      await reader.cancel().catch(() => undefined);
      return finish(
        false,
        `The file exceeds this upload's ${claimed.max_bytes}-byte limit.`,
        413
      );
    }
    chunks.push(value);
  }
  if (total === 0) return finish(false, 'The request body was empty.', 400);
  const bytes = Buffer.concat(chunks);

  const outcome = await completeUploadSlot(db, claimed, bytes);
  logger.info('upload slot {slotId} {status}: {detail}', {
    component: 'upload/route',
    tenantId: claimed.tenant_id,
    slotId: claimed.id,
    kind: claimed.kind,
    status: outcome.ok ? 'completed' : 'failed',
    detail: outcome.detail,
  });
  return NextResponse.json({ ok: outcome.ok, detail: outcome.detail }, { status: outcome.ok ? 200 : 502 });
}
