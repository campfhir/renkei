/**
 * Variables in a library prompt: `{{name}}` or `{{name:type}}` in the body,
 * and an optional trailing ```variables block (YAML) for what an inline
 * type cannot carry — required, options, min/max, help, a default.
 *
 *     Review {{file}} for {{focus:choice}}. Notes: {{notes:longtext}}
 *
 *     ```variables
 *     file:
 *       required: true
 *       help: Path in the repository
 *     focus:
 *       options: [security, performance, readability]
 *       default: security
 *     ```
 *
 * Pure: the editor previews it, the chat turn builds the form from it, and
 * the model test pins it. A prompt that does not parse still works — a
 * problem is reported, the variable falls back to a text field, and nothing
 * here throws.
 */

import { parse } from 'yaml';
import {
  MAX_QUESTION_FIELDS,
  MAX_QUESTION_FIELD_OPTIONS,
  type QuestionField,
  type QuestionFieldType,
} from '@renkei/agents';
import { isRecord } from '@renkei/guards';

export const VARIABLES_FENCE = 'variables';

export type PromptAnswer = string | string[];

export interface PromptVariables {
  /** The body without its variables block: what is sent, placeholders still in it. */
  template: string;
  /** One field per distinct variable, in order of first appearance. */
  fields: QuestionField[];
  /** A variable's default, where its block gave one. */
  defaults: Record<string, PromptAnswer>;
  /** What could not be read, in words for the author. The prompt still works. */
  problems: string[];
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([A-Za-z]+)\s*)?\}\}/g;
const BLOCK = new RegExp('(?:^|\\n)```' + VARIABLES_FENCE + '[ \\t]*\\n([\\s\\S]*?)\\n```[ \\t]*$');

/** The words an author may type for a type, and the type each means. */
const TYPE_ALIASES: Record<string, QuestionFieldType> = {
  text: 'text',
  string: 'text',
  longtext: 'longtext',
  textarea: 'longtext',
  number: 'number',
  choice: 'choice',
  select: 'choice',
  radio: 'choice',
  multi: 'multi',
  checkbox: 'multi',
  checkboxes: 'multi',
  checks: 'multi',
  date: 'date',
};

function fieldType(word: string | undefined): QuestionFieldType | null {
  if (word === undefined) return null;
  return TYPE_ALIASES[word.toLowerCase()] ?? null;
}

function defaultLabel(name: string): string {
  const spaced = name.replace(/_+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function readOptions(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const options = raw
    .filter((option) => typeof option === 'string' || typeof option === 'number')
    .map((option) => String(option).trim())
    .filter((option) => option !== '');
  return options.length > 0 ? [...new Set(options)].slice(0, MAX_QUESTION_FIELD_OPTIONS) : null;
}

function readBlock(text: string, problems: string[]): Record<string, Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = parse(text, { maxAliasCount: 0 });
  } catch (error) {
    problems.push(
      `The variables block is not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : 'unreadable'}`
    );
    return {};
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) {
    problems.push('The variables block must list variables by name.');
    return {};
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, settings] of Object.entries(parsed)) {
    if (settings === null || settings === undefined) out[name] = {};
    else if (isRecord(settings)) out[name] = settings;
    else problems.push(`"${name}" in the variables block must be a list of settings.`);
  }
  return out;
}

/** Split a prompt body into its template and the form its variables make. */
export function parsePromptVariables(body: string): PromptVariables {
  const problems: string[] = [];
  const trimmed = body.trimEnd();
  const match = BLOCK.exec(trimmed);
  const template = match ? trimmed.slice(0, match.index).trimEnd() : body;
  const block = match ? readBlock(match[1] ?? '', problems) : {};

  const inlineTypes = new Map<string, string | undefined>();
  for (const found of template.matchAll(PLACEHOLDER)) {
    const name = found[1];
    if (name === undefined) continue;
    const word = found[2];
    if (!inlineTypes.has(name) || (inlineTypes.get(name) === undefined && word !== undefined)) {
      inlineTypes.set(name, word);
    }
  }

  const fields: QuestionField[] = [];
  const defaults: Record<string, PromptAnswer> = {};
  for (const [name, inline] of inlineTypes) {
    if (fields.length >= MAX_QUESTION_FIELDS) {
      problems.push(
        `A prompt can ask at most ${MAX_QUESTION_FIELDS} questions; "${name}" and the rest are left as written.`
      );
      break;
    }
    const settings = block[name] ?? {};
    let type: QuestionFieldType = 'text';
    const inlineType = fieldType(inline);
    const blockWord = typeof settings.type === 'string' ? settings.type : undefined;
    const blockType = fieldType(blockWord);
    if (inline !== undefined && !inlineType) {
      problems.push(`"${name}": unknown type "${inline}", asking for text instead.`);
    } else if (inlineType) {
      type = inlineType;
    } else if (blockWord !== undefined && !blockType) {
      problems.push(`"${name}": unknown type "${blockWord}", asking for text instead.`);
    } else if (blockType) {
      type = blockType;
    }

    const options = readOptions(settings.options);
    if ((type === 'choice' || type === 'multi') && !options) {
      problems.push(`"${name}" is a ${type} but lists no options, asking for text instead.`);
      type = 'text';
    }

    const field: QuestionField = {
      name,
      label:
        typeof settings.label === 'string' && settings.label.trim()
          ? settings.label.trim()
          : defaultLabel(name),
      type,
      required: settings.required === true,
    };
    if ((type === 'choice' || type === 'multi') && options) field.options = options;
    if (typeof settings.help === 'string' && settings.help.trim())
      field.help = settings.help.trim();
    if (type === 'number') {
      if (typeof settings.min === 'number') field.min = settings.min;
      if (typeof settings.max === 'number') field.max = settings.max;
    }
    if ((type === 'choice' || type === 'multi') && typeof settings.other === 'string') {
      field.other = settings.other;
    }
    fields.push(field);

    const given = settings.default;
    if (given !== undefined && given !== null) {
      if (type === 'multi') {
        const list = (Array.isArray(given) ? given : [given]).map((item) => String(item));
        defaults[name] = list.filter((item) => field.options?.includes(item));
      } else if (typeof given !== 'object') {
        const text = given instanceof Date ? given.toISOString().slice(0, 10) : String(given);
        if (type !== 'choice' || field.options?.includes(text)) defaults[name] = text;
      }
    }
  }

  for (const name of Object.keys(block)) {
    if (!inlineTypes.has(name)) {
      problems.push(`"${name}" is in the variables block but not used in the prompt.`);
    }
  }
  return { template, fields, defaults, problems };
}

/** The prompt has at least one variable the person is to fill in. */
export function hasPromptVariables(body: string): boolean {
  return parsePromptVariables(body).fields.length > 0;
}

/**
 * The template with each placeholder replaced by its answer: a list reads
 * "a, b", a missing or empty answer leaves nothing, and a placeholder with no
 * field (past the limit) stays as the author wrote it.
 */
export function fillPromptTemplate(
  template: string,
  fields: QuestionField[],
  answers: Record<string, PromptAnswer | undefined>
): string {
  const known = new Set(fields.map((field) => field.name));
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    if (!known.has(name)) return whole;
    const answer = answers[name];
    if (answer === undefined) return '';
    return Array.isArray(answer) ? answer.join(', ') : answer;
  });
}
