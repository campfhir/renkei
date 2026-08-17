'use client';

/**
 * One step of the recipe: name, the chip-editor instruction (at most one
 * tool chip — the editor enforces it in the menu, the validator on the
 * wire), an optional "save the result as" name, and — once a tool chip
 * exists — the failure panel for that tool's enumerated conditions.
 *
 * Collapsible so a ten-step agent reads as ten sentences; the summary line
 * is written from the step's own data, never stored.
 */

import { useMemo, useState } from 'react';
import {
  instructionPreview,
  toolSegments,
  type AgentStep,
  type InstructionSegment,
} from '@renkei/agents';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { FailurePanel } from './failure-panel';
import { ChipEditor } from './chip-editor';
import type { ToolOption, VariableOption } from './options';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';

export interface StepCardProps {
  step: AgentStep;
  index: number;
  count: number;
  /** The org's per-step attempt ceiling — the tries select offers no more. */
  attemptsCap: number;
  onChange: (step: AgentStep) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  tools: ToolOption[];
  toolDescriptors: Map<string, ToolDescriptor>;
  variables: VariableOption[];
  invalidVars?: ReadonlySet<string>;
  issues: string[];
}

export function StepCard({
  step,
  index,
  count,
  attemptsCap,
  onChange,
  onMove,
  onDelete,
  tools,
  toolDescriptors,
  variables,
  invalidVars,
  issues,
}: StepCardProps) {
  const [open, setOpen] = useState(true);

  const summary = useMemo(() => {
    const text = instructionPreview(step.instruction).trim();
    const clipped = text.length > 90 ? `${text.slice(0, 90)}…` : text;
    const retries = step.failureHandling.some((entry) => entry.action === 'retry')
      ? ` — retries up to ${step.maxAttempts}×`
      : '';
    return clipped ? `${clipped}${retries}` : 'Empty step';
  }, [step]);

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

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <header className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold dark:bg-gray-800">
            {index + 1}
          </span>
          <span className="truncate text-sm font-medium">
            {step.name || `Step ${index + 1}`}
            {!open ? (
              <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">{summary}</span>
            ) : null}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1 text-gray-400">
          <button
            type="button"
            aria-label="Move step up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            className="rounded p-1 hover:text-gray-700 disabled:opacity-30 dark:hover:text-gray-200"
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Move step down"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            className="rounded p-1 hover:text-gray-700 disabled:opacity-30 dark:hover:text-gray-200"
          >
            ↓
          </button>
          <button
            type="button"
            aria-label="Delete step"
            onClick={onDelete}
            className="rounded p-1 hover:text-red-600"
          >
            ✕
          </button>
        </div>
      </header>

      {open ? (
        <div className="mt-3 space-y-3">
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
              ariaLabel={`Instruction for step ${index + 1}`}
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
              placeholder={`e.g. ${step.name.trim() || `Step ${index + 1}`} result`}
              onChange={(event) => {
                // Not trimmed here — trimming on keystroke makes spaces
                // untypable mid-name; the normalizer trims the edges on save.
                const saveAs = event.target.value;
                onChange(saveAs ? { ...step, saveAs } : { ...step, saveAs: undefined });
              }}
            />
          </div>

          {descriptor ? (
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
                  onSuccess === 'stop'
                    ? { ...step, onSuccess }
                    : (() => {
                        const { onSuccess: _dropped, ...rest } = step;
                        return rest;
                      })()
                )
              }
              tools={tools}
              variables={variables}
              invalidVars={invalidVars}
            />
          ) : step.tool === null ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              This step has no skill — it just thinks or writes. Add a skill chip to give it
              something to do and failure conditions to handle.
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
      ) : null}
    </section>
  );
}
