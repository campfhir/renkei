/**
 * The dynamic form an `ask_person` call builds — the agent-level
 * `canAskQuestions` capability's payload shape, not part of the drafted
 * agent (steps.ts): nothing here is authored ahead of time, it is built by
 * a step's own reasoning at run time and validated the moment the model
 * calls the tool (see apps/worker-agents/src/engine.ts).
 *
 * `QuestionField` (steps.ts) is the answerable control — reused verbatim,
 * since a question's field types and validation rules do not change
 * depending on whether they were planned ahead of time or built on the
 * fly. `FormNode` adds the two primitives a form needs to read clearly
 * once a run can raise several questions at once: `paragraph` for context
 * with nothing to answer, and one level of `group` to cluster related
 * fields under a heading — this is precisely what a "batch of pending
 * decisions, one card" author needs instead of a loop of single-question
 * approvals (see docs/approval-and-questions-design.md).
 */

import { isQuestionField, MAX_QUESTION_FIELDS, type QuestionField } from './steps';

export type FormNode =
  | ({ kind: 'field' } & QuestionField)
  | { kind: 'paragraph'; text: string }
  | { kind: 'group'; label: string; nodes: FormNode[] };

/** Total nodes (fields + paragraphs + group members) one form may carry. */
export const MAX_FORM_NODES = 40;
/** How many fields ONE group may hold — a group is a cluster, not a form. */
export const MAX_FORM_GROUP_NODES = MAX_QUESTION_FIELDS;
export const MAX_FORM_PARAGRAPH_CHARS = 2_000;
export const MAX_FORM_GROUP_LABEL_CHARS = 200;
/** Groups do not nest — one level clusters fields; a second would only
 *  reproduce the readability problem groups exist to fix. */
export const MAX_FORM_GROUP_DEPTH = 1;

function isFormFieldNode(value: unknown): value is Extract<FormNode, { kind: 'field' }> {
  if (typeof value !== 'object' || value === null) return false;
  const node: { kind?: unknown } = value;
  return node.kind === 'field' && isQuestionField(value);
}

function isParagraphNode(value: unknown): value is Extract<FormNode, { kind: 'paragraph' }> {
  if (typeof value !== 'object' || value === null) return false;
  const node: { kind?: unknown; text?: unknown } = value;
  return node.kind === 'paragraph' && typeof node.text === 'string';
}

function isGroupNode(
  value: unknown,
  allowNesting: boolean
): value is Extract<FormNode, { kind: 'group' }> {
  if (typeof value !== 'object' || value === null) return false;
  const node: { kind?: unknown; label?: unknown; nodes?: unknown } = value;
  if (node.kind !== 'group') return false;
  if (typeof node.label !== 'string') return false;
  if (!allowNesting) return false;
  return Array.isArray(node.nodes) && node.nodes.every((child) => isFormNodeShape(child, false));
}

function isFormNodeShape(value: unknown, allowGroups: boolean): value is FormNode {
  return isFormFieldNode(value) || isParagraphNode(value) || isGroupNode(value, allowGroups);
}

/** Structural check for one `FormNode` — a top-level entry (groups allowed). */
export function isFormNode(value: unknown): value is FormNode {
  return isFormNodeShape(value, true);
}

/**
 * A form out of untrusted JSON — dropping anything malformed rather than
 * throwing, same policy `parseQuestionFields` uses: a card whose spec
 * cannot be fully read still has to render as something a person can
 * answer, not a blank crash.
 */
export function parseFormNodes(value: unknown): FormNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isFormNode).slice(0, MAX_FORM_NODES);
}

/** Every field in a form, groups flattened — for answer checking. */
export function flattenFormFields(nodes: FormNode[]): QuestionField[] {
  const out: QuestionField[] = [];
  for (const node of nodes) {
    if (node.kind === 'field') {
      const { kind: _kind, ...field } = node;
      out.push(field);
    } else if (node.kind === 'group') {
      for (const child of node.nodes) {
        if (child.kind === 'field') {
          const { kind: _kind, ...field } = child;
          out.push(field);
        }
      }
    }
  }
  return out;
}

/** Total node count, groups' members included — what MAX_FORM_NODES caps. */
export function countFormNodes(nodes: FormNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.kind === 'group') count += node.nodes.length;
  }
  return count;
}
