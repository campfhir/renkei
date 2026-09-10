/**
 * Manual run-starting calls whose 409 "already in progress" response
 * becomes a confirm step rather than a plain error — shared by every
 * button that can start a run: "Run now" (the invoke route) and "Run
 * again with current steps" (the rerun route), so the two never drift on
 * what that response means or how confirm gets resent.
 */

import { sendJsonFull } from '@/lib/fetch-json';

export type InvokeAgentRunResult =
  | { kind: 'started'; runId: string | null }
  | { kind: 'needs-confirm'; message: string }
  | { kind: 'error'; message: string };

async function postConfirmable(url: string, confirm: boolean): Promise<InvokeAgentRunResult> {
  const result = await sendJsonFull<{ runId?: string; code?: string }>(url, 'POST', { confirm });
  if (result.error) {
    return result.data?.code === 'already-in-progress'
      ? { kind: 'needs-confirm', message: result.error }
      : { kind: 'error', message: result.error };
  }
  return { kind: 'started', runId: result.data?.runId ?? null };
}

export async function invokeAgentRun(
  tenantId: string,
  agentId: string,
  confirm = false
): Promise<InvokeAgentRunResult> {
  return postConfirmable(`/api/tenant/${tenantId}/agents/${agentId}/invoke`, confirm);
}

export async function rerunAgentRun(
  tenantId: string,
  agentId: string,
  runId: string,
  confirm = false
): Promise<InvokeAgentRunResult> {
  return postConfirmable(`/api/tenant/${tenantId}/agents/${agentId}/runs/${runId}/rerun`, confirm);
}

/**
 * Resume a FAILED run at the step it failed on, optionally with a note on
 * what to do differently there. Same confirm dance as the other two: a run
 * of the agent already in flight turns the 409 into a confirm step.
 */
export async function resumeAgentRun(
  tenantId: string,
  agentId: string,
  runId: string,
  guidance: string,
  confirm = false
): Promise<InvokeAgentRunResult> {
  const result = await sendJsonFull<{ runId?: string; code?: string }>(
    `/api/tenant/${tenantId}/agents/${agentId}/runs/${runId}/resume`,
    'POST',
    { guidance, confirm }
  );
  if (result.error) {
    return result.data?.code === 'already-in-progress'
      ? { kind: 'needs-confirm', message: result.error }
      : { kind: 'error', message: result.error };
  }
  return { kind: 'started', runId: result.data?.runId ?? null };
}
