'use client';

/**
 * The editor-panel body for one step — the fields StepCard used to show
 * inline, with the dense failure handling folded into a disclosure that
 * only opens itself when it holds a validation problem.
 */

import { toolSegments, type AgentStep, type InstructionSegment } from '@renkei/agents';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { FailurePanel } from './failure-panel';
import { ChipEditor } from './chip-editor';
import type { ToolOption, VariableOption } from './options';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';

export interface StepEditorProps {
  step: AgentStep;
  ordinal: number;
  /** The org's per-step attempt ceiling — the tries select offers no more. */
  attemptsCap: number;
  onChange: (step: AgentStep) => void;
  tools: ToolOption[];
  toolDescriptors: Map<string, ToolDescriptor>;
  variables: VariableOption[];
  invalidVars?: ReadonlySet<string>;
  issues: string[];
}

export function StepEditor({
  step,
  ordinal,
  attemptsCap,
  onChange,
  tools,
  toolDescriptors,
  variables,
  invalidVars,
  issues,
}: StepEditorProps) {
  const handleInstruction = (instruction: InstructionSegment[]) => {
    // The step's tool IS the tool chip in its body — one field, not two
    // places that can disagree.
    const chips = toolSegments(instruction);
    const tool = chips[0] ?? null;
    onChange({
      ...step,
      instruction,
      tool,
      // Handling for a tool that is gone would name conditions of nothing.
      failureHandling: tool === step.tool ? step.failureHandling : [],
    });
  };

  const descriptor = step.tool ? toolDescriptors.get(step.tool) : undefined;
  const failureIssuePresent = issues.length > 0 && step.failureHandling.length > 0;
  const failureHint = (() => {
    const retries = step.failureHandling.filter((entry) => entry.action === 'retry').length;
    const stop =
      step.onSuccess === 'stop'
        ? ' · stops when done'
        : step.onSuccess === 'stop-quiet'
          ? ' · stops silently when done'
          : '';
    if (retries === 0) return `every failure stops the agent${stop}`;
    return `${retries} ${retries === 1 ? 'retry' : 'retries'} configured${stop}`;
  })();

  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor={`step-name-${step.id}`}>
          Step name
        </label>
        <input
          id={`step-name-${step.id}`}
          className={inputClass}
          value={step.name}
          maxLength={80}
          placeholder="e.g. Find the ticket"
          onChange={(event) => onChange({ ...step, name: event.target.value })}
        />
      </div>

      <div>
        <label className={labelClass}>What should happen in this step?</label>
        <ChipEditor
          value={step.instruction}
          onChange={handleInstruction}
          tools={tools}
          variables={variables}
          maxTools={1}
          placeholder="Describe it in plain words — type / to add a skill or a detail"
          ariaLabel={`Instruction for step ${ordinal}`}
          invalidVars={invalidVars}
        />
      </div>

      <div>
        <label className={labelClass} htmlFor={`step-saveas-${step.id}`}>
          Save the result as{' '}
          <span className="font-normal text-gray-500 dark:text-gray-400">
            (optional — lets later steps use it)
          </span>
        </label>
        <input
          id={`step-saveas-${step.id}`}
          className={inputClass}
          value={step.saveAs ?? ''}
          placeholder={`e.g. ${step.name.trim() || `Step ${ordinal}`} result`}
          onChange={(event) => {
            // Not trimmed here — trimming on keystroke makes spaces
            // untypable mid-name; the normalizer trims the edges on save.
            const saveAs = event.target.value;
            onChange(saveAs ? { ...step, saveAs } : { ...step, saveAs: undefined });
          }}
        />
      </div>

      {descriptor ? (
        <details
          // Uncontrolled on purpose: passing `open={false}` would make React
          // snap it shut on every keystroke's re-render. The key remounts it
          // with `open` when a failure-path issue appears — an error must
          // never hide inside a closed disclosure.
          key={failureIssuePresent ? 'open' : 'closed'}
          {...(failureIssuePresent ? { open: true } : {})}
          className="rounded-lg border border-gray-200 p-3 dark:border-gray-800"
        >
          <summary className="cursor-pointer text-sm font-medium">
            If something goes wrong
            <span className="ml-2 font-normal text-gray-500">{failureHint}</span>
          </summary>
          <FailurePanel
            outcomes={descriptor.outcomes}
            handling={step.failureHandling}
            onChange={(failureHandling) => onChange({ ...step, failureHandling })}
            maxAttempts={step.maxAttempts}
            attemptsCap={attemptsCap}
            onMaxAttemptsChange={(maxAttempts) => onChange({ ...step, maxAttempts })}
            onSuccess={step.onSuccess ?? 'continue'}
            onOnSuccessChange={(onSuccess) =>
              onChange(
                onSuccess === 'continue'
                  ? (() => {
                      const { onSuccess: _dropped, ...rest } = step;
                      return rest;
                    })()
                  : { ...step, onSuccess }
              )
            }
            tools={tools}
            variables={variables}
            invalidVars={invalidVars}
          />
        </details>
      ) : step.tool === null ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          This step has no skill — it just thinks or writes. Add a skill chip to give it something
          to do and failure conditions to handle.
        </p>
      ) : null}

      {issues.length > 0 ? (
        <ul className="space-y-1">
          {issues.map((issue) => (
            <li key={issue} className="text-xs text-red-600 dark:text-red-400">
              {issue}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
