/**
 * The Metadata API's retrieve, as the admin connector asks for it: named
 * components of an org handed back as a zip in the Metadata API's own
 * layout, which a code project's checkout turns into source format with
 * the Salesforce CLI (apps/web/lib/code/salesforce-pull.ts).
 *
 * The bodies here are the short form the delegate accepts
 * (apps/worker-delegate/src/salesforce-soap.ts): it alone holds the token,
 * so it writes the envelope, the API version and the options, and a caller
 * says only which types and members, or which retrieve. What a name may
 * hold is the delegate's rule, repeated here so a selection is refused in
 * words before it is sent. Pure.
 */

import { isRecord, isString } from '@renkei/guards';
import { METADATA_NAMESPACE } from './metadata';
import { soapResult } from './xml';

export interface RetrieveSelection {
  /** A metadata type: `CustomObject`, `ApexClass`, `LightningComponentBundle`. */
  type: string;
  /** Full names, or `*` for every one of a type that takes it. */
  members: string[];
}

export const RETRIEVE_MAX_TYPES = 100;
export const RETRIEVE_MAX_MEMBERS = 5_000;

const TYPE = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const MEMBER = /^[A-Za-z0-9_.$%/* -]{1,255}$/;

/** A selection as a tool was given it, checked whole; the first problem in words. */
export function readRetrieveSelection(
  value: unknown
): { ok: true; types: RetrieveSelection[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: 'Name at least one metadata type and its members.' };
  }
  if (value.length > RETRIEVE_MAX_TYPES) {
    return { ok: false, error: `At most ${RETRIEVE_MAX_TYPES} metadata types in one pull.` };
  }
  const types: RetrieveSelection[] = [];
  let count = 0;
  for (const entry of value) {
    const type = isRecord(entry) && isString(entry.type) ? entry.type.trim() : '';
    if (!TYPE.test(type)) {
      return { ok: false, error: `“${type || String(entry)}” is not a metadata type’s name.` };
    }
    const given = isRecord(entry) && Array.isArray(entry.members) ? entry.members : [];
    const members = given.map((member) => (isString(member) ? member.trim() : ''));
    if (members.length === 0) {
      return { ok: false, error: `Name the ${type} members to pull, or * for all of them.` };
    }
    const bad = members.find((member) => !MEMBER.test(member));
    if (bad !== undefined) {
      return { ok: false, error: `“${bad}” is not a ${type} member’s full name.` };
    }
    count += members.length;
    types.push({ type, members });
  }
  if (count > RETRIEVE_MAX_MEMBERS) {
    return { ok: false, error: `At most ${RETRIEVE_MAX_MEMBERS} members in one pull.` };
  }
  return { ok: true, types };
}

/** The body that starts a retrieve of a checked selection. */
export function retrieveBody(types: readonly RetrieveSelection[]): string {
  const manifest = types
    .map(
      ({ type, members }) =>
        `<types><name>${type}</name>` +
        members.map((member) => `<members>${member}</members>`).join('') +
        '</types>'
    )
    .join('');
  return `<retrieve xmlns="${METADATA_NAMESPACE}">${manifest}</retrieve>`;
}

/** The body that asks how a retrieve is doing. */
export function checkRetrieveBody(id: string): string {
  return `<checkRetrieveStatus xmlns="${METADATA_NAMESPACE}"><asyncProcessId>${id}</asyncProcessId></checkRetrieveStatus>`;
}

/** The id of a retrieve Salesforce has started, from its answer. */
export function readRetrieveStarted(xml: string): { id: string } | { fault: string } {
  const answer = soapResult(xml, 'retrieve');
  if (!answer.ok) return { fault: answer.fault };
  const { result } = answer;
  const id = isString(result.id) ? result.id : '';
  return /^[A-Za-z0-9]{15,18}$/.test(id)
    ? { id }
    : { fault: 'Salesforce gave the retrieve no id.' };
}

export type RetrieveStatus =
  | { done: false }
  | {
      done: true;
      /** The zip, base64 as Salesforce sent it; empty when it failed. */
      zip: string;
      /** The components in the zip, the manifest left out. */
      components: { type: string; fullName: string }[];
      /** What Salesforce could not give: a name that names nothing, a type it does not know. */
      problems: string[];
      /** Why it failed, when it did. */
      error: string | null;
    }
  | { fault: string };

const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];

/** A checkRetrieveStatus answer: still running, or what came back. */
export function readRetrieveStatus(xml: string): RetrieveStatus {
  const answer = soapResult(xml, 'checkRetrieveStatus');
  if (!answer.ok) return { fault: answer.fault };
  const { result } = answer;
  if (result.done !== 'true') return { done: false };
  const components = list(result.fileProperties)
    .filter(isRecord)
    .map((file) => ({
      type: isString(file.type) ? file.type : '',
      fullName: isString(file.fullName) ? file.fullName : '',
    }))
    .filter((file) => file.type !== '' && file.type !== 'Package');
  const problems = list(result.messages)
    .filter(isRecord)
    .map((message) => (isString(message.problem) ? message.problem : ''))
    .filter((problem) => problem !== '');
  const failed = result.success !== 'true';
  return {
    done: true,
    zip: !failed && isString(result.zipFile) ? result.zipFile : '',
    components,
    problems,
    error: failed
      ? (isString(result.errorMessage) && result.errorMessage) || 'Salesforce could not finish it.'
      : null,
  };
}
