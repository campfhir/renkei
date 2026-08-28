'use client';

/**
 * Field-level validation plumbing for the editor panels.
 *
 * The validator reports issues with full paths (`steps.2.name`,
 * `steps.0.failureHandling.1`, …); `issuesByNode` routes each to its
 * owning node and keeps the remainder as the `field`. These helpers let an
 * editor claim the fields it renders — styling the offending input red and
 * putting the message right under it — while everything unclaimed still
 * shows in the editor's bottom list, so no message is ever lost.
 */

export interface NodeIssue {
  /** Path relative to the node: 'name', 'failureHandling.1', '' for node-level. */
  field: string;
  message: string;
}

function claims(field: string, claimed: string): boolean {
  return field === claimed || field.startsWith(`${claimed}.`);
}

/** Messages for one or more claimed fields (nested paths included). */
export function forField(issues: NodeIssue[], ...fields: string[]): string[] {
  return issues
    .filter((issue) => fields.some((field) => claims(issue.field, field)))
    .map((issue) => issue.message);
}

/** Messages NOT claimed by any named field — the editor's bottom list. */
export function exceptFields(issues: NodeIssue[], ...fields: string[]): string[] {
  return issues
    .filter((issue) => !fields.some((field) => claims(issue.field, field)))
    .map((issue) => issue.message);
}

/**
 * The editors' shared input styling with the invalid state baked in — a
 * conditional class string rather than an appended override, because two
 * border-color utilities on one element resolve by stylesheet order, not
 * by position in the class attribute.
 */
export function fieldClass(invalid: boolean): string {
  return `w-full rounded-md border bg-white px-3 py-2 text-sm dark:bg-gray-900 ${
    invalid ? 'border-red-400 dark:border-red-700' : 'border-gray-300 dark:border-gray-700'
  }`;
}

/** The red message list rendered directly under the offending field. */
export function FieldIssues({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {messages.map((message) => (
        <li key={message} role="alert" className="text-xs text-red-600 dark:text-red-400">
          {message}
        </li>
      ))}
    </ul>
  );
}
