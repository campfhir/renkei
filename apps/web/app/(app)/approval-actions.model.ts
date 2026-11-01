/**
 * An approval card's decision controls (approval-actions.tsx): the note
 * for the agent, what Accept and Decline send, and what the server's
 * answer leaves on the card. Tested in approval-actions.model.test.ts.
 */

import { isRecord, isString } from '@renkei/guards';

export interface ApprovalState {
  comment: string;
  busy: boolean;
  /** The decision is recorded but the run resumes late (a 502 with a warning). */
  notice: string | null;
  error: string | null;
}

export type ApprovalOutcome =
  { kind: 'decided' } | { kind: 'delayed'; warning: string } | { kind: 'refused'; error: string };

export type ApprovalAction =
  | { type: 'commentChanged'; value: string }
  | { type: 'sent' }
  | { type: 'answered'; outcome: ApprovalOutcome }
  | { type: 'unreachable' };

export const initialApproval: ApprovalState = {
  comment: '',
  busy: false,
  notice: null,
  error: null,
};

export function approvalReducer(state: ApprovalState, action: ApprovalAction): ApprovalState {
  switch (action.type) {
    case 'commentChanged':
      return { ...state, comment: action.value };
    case 'sent':
      return { ...state, busy: true, notice: null, error: null };
    case 'answered': {
      const { outcome } = action;
      return {
        ...state,
        busy: false,
        notice: outcome.kind === 'delayed' ? outcome.warning : null,
        error: outcome.kind === 'refused' ? outcome.error : null,
      };
    }
    case 'unreachable':
      return { ...state, busy: false, error: 'Could not reach the server.' };
  }
}

/** What Accept or Decline POSTs: the decision and the note, trimmed. */
export function approvalRequest(
  decision: 'approve' | 'decline',
  comment: string
): { decision: 'approve' | 'decline'; comment: string } {
  return { decision, comment: comment.trim() };
}

/**
 * What the server's answer means for the card. A 502 with a warning is
 * still a decision: it is durably recorded and the worker resumes the run
 * on its own — the warning is about latency, not loss — so the feed
 * refreshes either way.
 */
export function approvalOutcome(status: number, body: unknown): ApprovalOutcome {
  const record = isRecord(body) ? body : {};
  if (status === 502 && isString(record.warning)) {
    return { kind: 'delayed', warning: record.warning };
  }
  if (status < 200 || status >= 300) {
    return {
      kind: 'refused',
      error: isString(record.error) ? record.error : `Request failed (${status})`,
    };
  }
  return { kind: 'decided' };
}
