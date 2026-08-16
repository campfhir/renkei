'use client';

/**
 * The whole builder on one scrolling page — name, triggers, steps — not a
 * wizard: the point of drafting a recipe is seeing it whole, and a
 * non-technical author reviews by reading top to bottom.
 *
 * Validation runs the SAME @renkei/agents function the server treats as
 * authority, here only for inline hints; the server's answer (422 +
 * issues) renders identically, so the client check being bypassed changes
 * nothing but latency. Save → review overlay with the generated
 * description; enabling is its own deliberate act.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { randomUUID } from '@/lib/agents/uuid';
import {
  BUILTIN_VARIABLES,
  triggerVariableNames,
  validateAgentDraft,
  type AgentStep,
  type AgentStepsDoc,
  type ValidationIssue,
} from '@renkei/agents';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import type { MintedApiKey, StoredAgent } from '@/lib/agents/store';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { toToolOptions, toVariableOptions, type VariableOption } from './options';
import { StepCard } from './step-card';
import { TriggerPanel, type AgentChoice, type BuilderTrigger } from './trigger-panel';
import { ReviewPanel } from './review-panel';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';

export interface AgentBuilderProps {
  slug: string;
  tenantId: string;
  tools: ToolDescriptor[];
  /** The caller's other agents (for agent-finished triggers). */
  otherAgents: AgentChoice[];
  /** Org models the agent may pin (label + id); empty hides the picker. */
  models: { id: string; label: string; isDefault: boolean }[];
  /** Present in edit mode. */
  existing?: StoredAgent;
}

interface SaveResponse {
  agentId?: string;
  apiKeys?: MintedApiKey[];
  descriptionPending?: boolean;
  agent?: StoredAgent;
  issues?: ValidationIssue[];
}

function notesOf(agent: StoredAgent | undefined | null): string[] {
  return Array.isArray(agent?.reviewNotes)
    ? agent.reviewNotes.filter((note): note is string => typeof note === 'string')
    : [];
}

function newStep(): AgentStep {
  return {
    id: randomUUID(),
    name: '',
    instruction: [],
    tool: null,
    maxAttempts: 3,
    failureHandling: [],
  };
}

export function AgentBuilder({
  slug,
  tenantId,
  tools,
  otherAgents,
  models,
  existing,
}: AgentBuilderProps) {
  const router = useRouter();
  const [agentId, setAgentId] = useState<string | null>(existing?.id ?? null);
  const [name, setName] = useState(existing?.name ?? '');
  const [steps, setSteps] = useState<AgentStep[]>(existing?.steps.steps ?? [newStep()]);
  const [triggers, setTriggers] = useState<BuilderTrigger[]>(
    existing?.triggers.map((trigger) => ({
      id: trigger.id,
      draft: trigger.draft,
      enabled: trigger.enabled,
      keyHint: trigger.keyHint,
      lastError: trigger.lastError,
    })) ?? []
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [llmModelId, setLlmModelId] = useState<string | null>(existing?.llmModelId ?? null);
  const [saving, setSaving] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [review, setReview] = useState<{
    description: string | null;
    reviewNotes: string[];
    apiKeys: MintedApiKey[];
    pending: boolean;
  } | null>(null);

  // The summary is written server-side AFTER the save response; poll the
  // agent until its status resolves so the panel can stop showing the
  // writing indicator. Bounded: after ~45s the panel falls back to its
  // "couldn't write yet" wording.
  useEffect(() => {
    if (!review?.pending || !agentId) return;
    let polls = 0;
    const timer = setInterval(async () => {
      polls += 1;
      const result = await getJson<{ agent: StoredAgent }>(
        `/api/tenant/${tenantId}/agents/${agentId}`
      );
      const agent = result.data?.agent;
      if (agent && agent.descriptionStatus !== 'stale') {
        clearInterval(timer);
        setReview((current) =>
          current
            ? {
                ...current,
                pending: false,
                description: agent.description,
                reviewNotes: notesOf(agent),
              }
            : current
        );
      } else if (polls >= 22) {
        clearInterval(timer);
        setReview((current) => (current ? { ...current, pending: false } : current));
      }
    }, 2_000);
    return () => clearInterval(timer);
  }, [review?.pending, agentId, tenantId]);

  const toolOptions = useMemo(() => toToolOptions(tools), [tools]);
  const toolDescriptors = useMemo(() => new Map(tools.map((tool) => [tool.name, tool])), [tools]);

  const stepsDoc: AgentStepsDoc = useMemo(() => ({ version: 1, steps }), [steps]);
  const draft = useMemo(
    () => ({
      name,
      steps: stepsDoc,
      triggers: triggers.map((trigger) => trigger.draft),
      enabled,
      llmModelId,
    }),
    [name, stepsDoc, triggers, enabled, llmModelId]
  );

  const variables: VariableOption[] = useMemo(() => {
    const fromTriggers = triggerVariableNames(draft.triggers).map((varName) => ({
      name: varName,
      label: varName.replace(/^trigger\./, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
      description: 'Provided by a trigger when the agent starts.',
      source: 'trigger' as const,
    }));
    const fromSteps = steps.flatMap((step) =>
      step.saveAs
        ? [
            {
              name: step.saveAs,
              label: step.saveAs,
              description: `Saved by the step “${step.name || 'unnamed'}”.`,
              source: 'step' as const,
            },
          ]
        : []
    );
    return toVariableOptions([...BUILTIN_VARIABLES, ...fromTriggers, ...fromSteps]);
  }, [draft.triggers, steps]);

  const knownVarNames = useMemo(() => new Set(variables.map((v) => v.name)), [variables]);
  const invalidVars = useMemo(() => {
    const used = new Set<string>();
    for (const step of steps) {
      for (const segment of [
        ...step.instruction,
        ...step.failureHandling.flatMap((h) => h.guidance ?? []),
      ]) {
        if (segment.t === 'var' && !knownVarNames.has(segment.name)) used.add(segment.name);
      }
    }
    return used;
  }, [steps, knownVarNames]);

  const clientIssues = useMemo(() => validateAgentDraft(draft, tools), [draft, tools]);
  const issues = serverIssues.length > 0 ? serverIssues : clientIssues;
  const issuesAt = (prefix: string) =>
    issues.filter((issue) => issue.path.startsWith(prefix)).map((issue) => issue.message);

  const persist = async (withEnabled: boolean): Promise<SaveResponse | null> => {
    setSaveError(null);
    const payload = {
      name,
      steps: stepsDoc,
      triggers,
      enabled: withEnabled,
      llmModelId,
    };
    const url = agentId
      ? `/api/tenant/${tenantId}/agents/${agentId}`
      : `/api/tenant/${tenantId}/agents`;
    const result = await sendJsonFull<SaveResponse>(url, agentId ? 'PUT' : 'POST', payload);
    if (result.status === 422 && result.data?.issues) {
      setServerIssues(result.data.issues);
      return null;
    }
    if (result.error || !result.data) {
      setSaveError(result.error ?? 'The agent could not be saved.');
      return null;
    }
    setServerIssues([]);
    return result.data;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await persist(enabled);
      if (!saved) return;
      const savedId = saved.agentId ?? saved.agent?.id ?? agentId;
      if (savedId) setAgentId(savedId);
      // Trigger ids come back on the stored agent; adopt them so the next
      // save reconciles instead of re-creating (and re-keying) triggers.
      const storedTriggers = saved.agent?.triggers;
      if (storedTriggers) {
        setTriggers(
          storedTriggers.map((trigger) => ({
            id: trigger.id,
            draft: trigger.draft,
            enabled: trigger.enabled,
            keyHint: trigger.keyHint,
            lastError: trigger.lastError,
          }))
        );
      }
      setReview({
        description: saved.agent?.description ?? null,
        reviewNotes: notesOf(saved.agent),
        apiKeys: saved.apiKeys ?? [],
        pending: saved.descriptionPending === true,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleEnable = async () => {
    setEnabling(true);
    try {
      const saved = await persist(true);
      if (saved) {
        setEnabled(true);
      }
    } finally {
      setEnabling(false);
    }
  };

  const updateStep = (index: number, step: AgentStep) => {
    setSteps((current) => current.map((existingStep, at) => (at === index ? step : existingStep)));
  };

  return (
    <div className="space-y-6 pb-24">
      <section>
        <label className="mb-1 block text-sm font-medium" htmlFor="agent-name">
          Name it
        </label>
        <input
          id="agent-name"
          className={inputClass}
          value={name}
          maxLength={200}
          placeholder="e.g. Ticket from urgent email"
          onChange={(event) => setName(event.target.value)}
        />
        {issuesAt('name').map((message) => (
          <p key={message} className="mt-1 text-xs text-red-600 dark:text-red-400">
            {message}
          </p>
        ))}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">When should it run?</h2>
        <TriggerPanel
          triggers={triggers}
          onChange={(next) => {
            setTriggers(next);
            setServerIssues([]);
          }}
          otherAgents={otherAgents}
          issues={issuesAt('triggers')}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">What should it do?</h2>
        <div className="space-y-3">
          {steps.map((step, index) => (
            <StepCard
              key={step.id}
              step={step}
              index={index}
              count={steps.length}
              onChange={(next) => updateStep(index, next)}
              onMove={(direction) => {
                setSteps((current) => {
                  const next = [...current];
                  const target = index + direction;
                  if (target < 0 || target >= next.length) return current;
                  [next[index], next[target]] = [next[target], next[index]];
                  return next;
                });
              }}
              onDelete={() => setSteps((current) => current.filter((_, at) => at !== index))}
              tools={toolOptions}
              toolDescriptors={toolDescriptors}
              variables={variables}
              invalidVars={invalidVars}
              issues={issuesAt(`steps.${index}`)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setSteps((current) => [...current, newStep()])}
          className="mt-3 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + Add a step
        </button>
        {issues
          .filter((issue) => issue.path === 'steps')
          .map((issue) => (
            <p key={issue.message} className="mt-1 text-xs text-red-600 dark:text-red-400">
              {issue.message}
            </p>
          ))}
      </section>

      {models.length > 0 ? (
        <section>
          <label className="mb-1 block text-sm font-medium" htmlFor="agent-model">
            Which model runs it?
          </label>
          <select
            id="agent-model"
            className={inputClass}
            value={llmModelId ?? ''}
            onChange={(event) => setLlmModelId(event.target.value || null)}
          >
            <option value="">
              Organization default
              {models.find((model) => model.isDefault)
                ? ` (${models.find((model) => model.isDefault)?.label})`
                : ''}
            </option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </section>
      ) : null}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 sm:px-2">
          <p className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400">
            {issues.length > 0
              ? `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix before saving`
              : enabled
                ? 'This agent is on.'
                : 'Saved agents start turned off — you review, then turn them on.'}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {saveError ? (
              <span className="text-xs text-red-600 dark:text-red-400">{saveError}</span>
            ) : null}
            <button
              type="button"
              onClick={() => router.push(`/${slug}/agents`)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || clientIssues.length > 0}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {review ? (
        <ReviewPanel
          description={review.description}
          reviewNotes={review.reviewNotes}
          descriptionPending={review.pending}
          apiKeys={review.apiKeys}
          enabled={enabled}
          enabling={enabling}
          onEnable={handleEnable}
          onKeepEditing={() => setReview(null)}
          onDone={() => router.push(`/${slug}/agents`)}
        />
      ) : null}
    </div>
  );
}
