/**
 * The actions on a Salesforce admin change request's review page
 * (change-actions.tsx): which buttons a person sees by role and by the
 * request's state, what each says and when it is off, the decline note,
 * what Approve or Withdraw sends, and what a refusal leaves on screen.
 *
 * The component posts and dispatches what the person did and what the
 * server answered; everything decided from that is here, and tested in
 * change-actions.model.test.ts. The routes' own refusals (an operator
 * only, a request in words, no longer pending) are route tests beside
 * app/api/salesforce-admin/changes/[changeId]/apply and …/cancel.
 */

import { isRecord } from '@renkei/guards';

/** Approve (apply) or withdraw/decline (cancel): the route each posts to. */
export type ChangeAction = 'apply' | 'cancel';

export interface ChangeActionsProps {
  /** The connector's name, for the button. */
  orgName: string;
  /** Why approving is refused right now (validation failed, read-only mode…); null when it is not. */
  applyBlocked: string | null;
  /** Nothing to deploy — access or assignments written as data — so the button says Apply. */
  dataOnly?: boolean;
  /** An operator: may approve and decline. Anyone else may only withdraw their own. */
  canApprove: boolean;
  /** A request in words: nothing to approve, only to build elsewhere or decline. */
  isRequest?: boolean;
  /** This is the person's own request. */
  isOwner: boolean;
}

export interface ChangeActionsState {
  busy: ChangeAction | null;
  /** What the last refusal said. */
  notice: string | null;
  /** Approved this visit: the job runs on the server. */
  queued: boolean;
  /** The operator opened the decline note. */
  declining: boolean;
  note: string;
}

export type ChangeActionsEvent =
  | { type: 'startDecline' }
  | { type: 'noteChanged'; note: string }
  | { type: 'sent'; action: ChangeAction }
  | { type: 'succeeded'; action: ChangeAction }
  | { type: 'failed'; message: string };

export const initialChangeActions: ChangeActionsState = {
  busy: null,
  notice: null,
  queued: false,
  declining: false,
  note: '',
};

export function changeActionsReducer(
  state: ChangeActionsState,
  event: ChangeActionsEvent
): ChangeActionsState {
  switch (event.type) {
    case 'startDecline':
      return { ...state, declining: true };
    case 'noteChanged':
      return { ...state, note: event.note };
    case 'sent':
      return { ...state, busy: event.action, notice: null };
    case 'succeeded':
      return { ...state, busy: null, queued: state.queued || event.action === 'apply' };
    case 'failed':
      return { ...state, busy: null, notice: event.message };
  }
}

/** Where an action posts. */
export function actionUrl(changeId: string, action: ChangeAction): string {
  return `/api/salesforce-admin/changes/${changeId}/${action}`;
}

/** What an action sends: a decline or withdrawal carries the note; approving sends nothing. */
export function requestBody(action: ChangeAction, state: ChangeActionsState): { note?: string } {
  return action === 'cancel' ? { note: state.note } : {};
}

/** What a refusal shows: the route's own words, or a plain fallback per action. */
export function failureMessage(action: ChangeAction, body: unknown): string {
  if (isRecord(body) && typeof body.error === 'string' && body.error) return body.error;
  return action === 'apply' ? 'Could not approve the change' : 'Could not cancel the change';
}

export interface ChangeActionsView {
  /** Why approving is refused, shown to an operator over a proposal. */
  blocked: string | null;
  /** "An operator reviews…": for anyone who cannot approve. */
  waitsForOperator: boolean;
  /** The decline note's field. */
  noteField: boolean;
  approve: { label: string; disabled: boolean } | null;
  decline: { disabled: boolean } | null;
  /** Send the decline (operator) or Withdraw it (the requester). */
  send: { label: string; disabled: boolean } | null;
}

/** What the actions area shows, for this person and this request, now. */
export function changeActionsView(
  props: ChangeActionsProps,
  state: ChangeActionsState
): ChangeActionsView {
  const { canApprove, isRequest = false, isOwner, applyBlocked } = props;
  const idle = state.busy === null && !state.queued;
  const approveLabel =
    state.busy === 'apply'
      ? 'Approving…'
      : props.dataOnly
        ? `Approve and apply in ${props.orgName}`
        : `Approve and deploy to ${props.orgName}`;
  const sends = (state.declining && canApprove) || (!canApprove && isOwner);
  return {
    blocked: applyBlocked && canApprove && !isRequest ? applyBlocked : null,
    waitsForOperator: !canApprove,
    noteField: state.declining && canApprove,
    approve:
      canApprove && !isRequest
        ? { label: approveLabel, disabled: !idle || applyBlocked !== null }
        : null,
    decline: canApprove && !state.declining ? { disabled: !idle } : null,
    send: sends
      ? {
          label:
            state.busy === 'cancel'
              ? 'Cancelling…'
              : canApprove
                ? 'Send the decline'
                : 'Withdraw it',
          disabled: !idle,
        }
      : null,
  };
}
