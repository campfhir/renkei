/**
 * The Apex panel's Run tests: the checkout's Apex sent to an org as a
 * validation that runs the named test classes — Salesforce compiles and
 * tests it, and nothing in the org changes — then read until it ends.
 *
 *   POST { org, tests: string[], names?: string[] } → StartedTests
 *   GET ?org=…&deployId=…&measure=class:Foo,trigger:Bar → TestReport
 *
 * The panel starts a run and asks after it every few seconds (the GET
 * waits for nothing). `measure` is what the run's coverage is held to —
 * the classes and triggers it sent, as the POST answered; without it,
 * everything the tests covered. Both on the person's own admin connection
 * with the Apex capability; starting one is the chat owner's and an
 * editor's.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isRecord } from '@renkei/guards';
import type { ApexUnit } from '@renkei/connector-salesforce';
import { apexNames, apexTestStatus, failed, startApexTests } from '@/lib/code/salesforce-apex';
import { apexFailureResponse, apexRouteContext } from '@/lib/code/salesforce-apex-route';
import { jsonError } from '@/lib/chat/route-support';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const ready = await apexRouteContext(request, params, { write: true });
  if (!ready.ok) return ready.response;
  const body: unknown = await request.json().catch(() => null);
  const input = isRecord(body) ? body : {};
  const started = await startApexTests(ready.context.checkout, ready.context.caller, {
    ...(typeof input.org === 'string' ? { org: input.org } : {}),
    tests: apexNames(input.tests),
    names: apexNames(input.names),
  });
  if (failed(started)) return apexFailureResponse(ready.context, started, 'run Apex tests');
  logger.info('{actor} started Apex tests {tests} in {where} from the code project "{project}"', {
    component: 'api/code/salesforce-apex',
    ...who(ready.context.session),
    tests: apexNames(input.tests).join(', '),
    where: started.where,
    deployId: started.deployId,
    project: ready.context.project.name,
    projectId: ready.context.project.id,
  });
  return NextResponse.json(started);
}

/** `class:Foo,trigger:Bar` → the units, or null when none is given. */
function measuredOf(value: string | null): ApexUnit[] | null {
  if (!value) return null;
  const units = value.split(',').flatMap((entry): ApexUnit[] => {
    const match = /^(class|trigger):([A-Za-z][A-Za-z0-9_]{0,79})$/.exec(entry.trim());
    return match ? [{ kind: match[1] === 'class' ? 'class' : 'trigger', name: match[2] }] : [];
  });
  return units;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const ready = await apexRouteContext(request, params, { write: false });
  if (!ready.ok) return ready.response;
  const url = new URL(request.url);
  const deployId = url.searchParams.get('deployId') ?? '';
  if (!/^[A-Za-z0-9]{15,18}$/.test(deployId)) return jsonError(400, 'bad-request', 'Not a run id.');
  const report = await apexTestStatus(ready.context.caller, {
    org: url.searchParams.get('org') ?? undefined,
    deployId,
    measured: measuredOf(url.searchParams.get('measure')),
    waitMs: 0,
  });
  if (failed(report)) return apexFailureResponse(ready.context, report, 'read an Apex test run');
  return NextResponse.json(report);
}
