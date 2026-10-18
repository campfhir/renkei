/**
 * The agent's definition as the overview reads it: its instructions —
 * Markdown, with each `## Section` set as a heading so the structure the
 * builder writes to stays visible — and the tools it may use.
 */

import React from 'react';
import { friendlyToolName } from '@/lib/tool-name';

/** The instructions split at their `## ` headings; text before the first is its own block. */
function sectionsOf(instructions: string): { heading: string | null; body: string }[] {
  const sections: { heading: string | null; body: string[] }[] = [{ heading: null, body: [] }];
  for (const line of instructions.split('\n')) {
    const match = /^##\s+(.+)$/.exec(line.trim());
    if (match) sections.push({ heading: match[1].trim(), body: [] });
    else sections[sections.length - 1].body.push(line);
  }
  return sections
    .map((section) => ({ heading: section.heading, body: section.body.join('\n').trim() }))
    .filter((section) => section.heading !== null || section.body.length > 0);
}

export default function InstructionsView({
  instructions,
  tools,
}: {
  instructions: string;
  tools: string[];
}) {
  const sections = sectionsOf(instructions);
  return (
    <div className="space-y-6">
      <section
        aria-label="Instructions"
        className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
      >
        {sections.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No instructions yet.</p>
        ) : (
          <div className="space-y-4">
            {sections.map((section, index) => (
              <div key={`${section.heading ?? ''}-${index}`}>
                {section.heading ? (
                  <h3 className="text-sm font-semibold">{section.heading}</h3>
                ) : null}
                {section.body ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">
                    {section.body}
                  </p>
                ) : (
                  <p className="mt-1 text-sm italic text-gray-400">(empty)</p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      <section aria-label="Tools">
        <h2 className="mb-2 text-sm font-semibold">Tools</h2>
        {tools.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No tools — the agent can only reason over what triggered it.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {tools.map((tool) => (
              <li
                key={tool}
                title={tool}
                className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs dark:border-gray-800 dark:bg-gray-900"
              >
                {friendlyToolName(tool, null)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
