'use client';

/**
 * Field-level validation plumbing for the builder: the validator reports
 * issues with paths (`name`, `instructions`, `tools.2`, `triggers.0`), and
 * these helpers style the offending input red and put the message right
 * under it.
 */

/**
 * The builder's shared input styling with the invalid state baked in — a
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
