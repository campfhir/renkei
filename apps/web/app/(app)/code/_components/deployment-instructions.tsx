'use client';

/**
 * "Instructions for another tool" on the Environments page: the project's
 * deploy reports and health check-ins as Markdown, to copy into an LLM
 * working in the repository (deployment-instructions.model.ts says what
 * the page holds). Shown once the browser knows its own address.
 */

import { useState, useSyncExternalStore } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { deploymentInstructions, type InstructionsInput } from './deployment-instructions.model';
import { secondaryButtonClass } from './pipeline-parts';

const subscribe = () => () => {};
const readOrigin = () => window.location.origin;
const serverOrigin = () => null;

export default function DeploymentInstructions(props: Omit<InstructionsInput, 'origin'>) {
  const origin = useSyncExternalStore(subscribe, readOrigin, serverOrigin);
  const [copied, setCopied] = useState(false);
  const text = origin ? deploymentInstructions({ ...props, origin }) : null;
  if (!text) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard here: the text is on screen to select.
    }
  };

  return (
    <details
      className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800"
      data-testid="deployment-instructions"
    >
      <summary className="cursor-pointer font-semibold">Instructions for another tool</summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs text-gray-500">
          Copy this Markdown into an LLM tool working in the repository. It sets up deploy reports
          and health check-ins for these environments. It holds no secrets: tokens are named, not
          shown.
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void copy()}
            className={`inline-flex items-center gap-1 ${secondaryButtonClass}`}
          >
            <Icon path={copied ? ICONS.check : ICONS.copy} className="h-3.5 w-3.5" />
            {copied ? 'Copied' : 'Copy the Markdown'}
          </button>
        </div>
        <pre className="max-h-96 overflow-auto rounded-md border border-gray-200 bg-white p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap dark:border-gray-700 dark:bg-gray-900">
          {text}
        </pre>
      </div>
    </details>
  );
}
