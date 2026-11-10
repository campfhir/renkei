/**
 * One ADManager Plus instance's edit page (instance-config-form.tsx), with
 * no network or React: the draft as the stored instance fills it, the
 * transport-security banner (from what is STORED, not what is typed), what
 * Save, Test and Delete leave on screen, and the rule that a load landing
 * after the person started typing does not put the stored values back.
 * The draft itself (what Save sends, the URL preview) is
 * ../instance-list.model.ts. Tested in instance-config-form.model.test.ts.
 */

import { INSECURE_MODE_LABELS, insecureTransportModes } from '@/lib/insecure-transport-modes';
import {
  editDraft,
  emptyDraft,
  probeText,
  type InstanceDraft,
  type ProbeResponse,
} from '../instance-list.model';

/** What GET /api/admin/admanager/<id> answers under `instance`. */
export interface StoredInstance {
  id: string;
  name: string;
  environment: string;
  baseUrl: string;
  tlsVerify: boolean;
  hasCustomCa: boolean;
  allowInsecureHttp: boolean;
  resetPasswordTemplateName: string | null;
  enabled: boolean;
}

export interface InstanceFormState {
  /** null until the first load answers. */
  draft: InstanceDraft | null;
  /** The person changed the draft since it was last loaded or saved. */
  edited: boolean;
  busy: boolean;
  status: { kind: 'ok' | 'error'; text: string } | null;
  /** The protections the STORED instance has switched off, as the banner names them. */
  insecure: string[];
}

export const initialInstanceForm: InstanceFormState = {
  draft: null,
  edited: false,
  busy: false,
  status: null,
  insecure: [],
};

export type InstanceFormAction =
  | { type: 'loaded'; instance: StoredInstance }
  | { type: 'load-failed'; error: string }
  | { type: 'edit'; patch: Partial<InstanceDraft> }
  /** Save, Test or Delete went out. */
  | { type: 'sent' }
  | { type: 'saved' }
  | { type: 'tested'; probe: ProbeResponse }
  /** Save, Test or Delete was refused, or did not answer. */
  | { type: 'failed'; error: string };

/** The draft a stored instance opens as: no CA pasted, the template blank when none is set. */
export function draftFromInstance(instance: StoredInstance): InstanceDraft {
  return {
    ...emptyDraft(),
    name: instance.name,
    environment: instance.environment,
    baseUrl: instance.baseUrl,
    tlsVerify: instance.tlsVerify,
    hasCustomCa: instance.hasCustomCa,
    allowInsecureHttp: instance.allowInsecureHttp,
    resetPasswordTemplateName: instance.resetPasswordTemplateName ?? '',
    enabled: instance.enabled,
  };
}

export function instanceFormReducer(
  state: InstanceFormState,
  action: InstanceFormAction
): InstanceFormState {
  switch (action.type) {
    case 'loaded': {
      const insecure = insecureTransportModes(action.instance).map(
        (mode) => INSECURE_MODE_LABELS[mode]
      );
      // A load that lands after the person started typing (a second mount,
      // a slow first answer) keeps what they typed; the banner still follows
      // what is stored.
      if (state.draft && state.edited) return { ...state, insecure };
      return { ...state, draft: draftFromInstance(action.instance), edited: false, insecure };
    }
    case 'load-failed':
      return { ...state, status: { kind: 'error', text: action.error } };
    case 'edit':
      return state.draft
        ? { ...state, draft: editDraft(state.draft, action.patch), edited: true }
        : state;
    case 'sent':
      return { ...state, busy: true, status: null };
    case 'saved':
      // What was typed is stored: the next load is the truth again.
      return { ...state, busy: false, edited: false, status: { kind: 'ok', text: 'Saved.' } };
    case 'tested':
      return {
        ...state,
        busy: false,
        status: { kind: action.probe.ok ? 'ok' : 'error', text: probeText(action.probe) },
      };
    case 'failed':
      return { ...state, busy: false, status: { kind: 'error', text: action.error } };
  }
}

export const DELETE_CONFIRMATION =
  "Delete this instance? Everyone's stored connections to it go with it.";
