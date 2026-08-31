/**
 * The "Run now" button's own call to the invoke route, shared by the
 * agents list and the agent detail page so the two never drift on how a
 * 409 "already in progress" response becomes a confirm step rather than
 * a plain error.
 */

import { sendJsonFull } from '@/lib/fetch-json';

export type InvokeAgentRunResult =
  | { kind: 'started'; runId: string | null }
  | { kind: 'needs-confirm'; message: string }
  | { kind: 'error'; message: string };

export async function invokeAgentRun(
  tenantId: string,
  agentId: string,
  confirm = false
): Promise<InvokeAgentRunResult> {
  const result = await sendJsonFull<{ runId?: string; code?: string }>(
    `/api/tenant/${tenantId}/agents/${agentId}/invoke`,
    'POST',
    { confirm }
  );
  if (result.error) {
    return result.data?.code === 'already-in-progress'
      ? { kind: 'needs-confirm', message: result.error }
      : { kind: 'error', message: result.error };
  }
  return { kind: 'started', runId: result.data?.runId ?? null };
}
