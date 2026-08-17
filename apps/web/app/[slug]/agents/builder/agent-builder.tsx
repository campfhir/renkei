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
import { parseReviewNotes, type ReviewNote } from '@/lib/agents/notes';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { toToolOptions, toVariableOptions, type VariableOption } from './options';
import { StepCard } from './step-card';
import { TriggerPanel, type AgentChoice, type BuilderTrigger } from './trigger-panel';
import type { CalendarOption } from './schedule-picker';
import { ReviewPanel } from './review-panel';

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';

export interface AgentBuilderProps {
  slug: string;
  tenantId: string;
  tools: ToolDescriptor[];
  /** The caller's other agents (for agent-finished triggers). */
  otherAgents: AgentChoice[];
  /** The org's holiday calendars (for schedule blackouts). */
  calendars: CalendarOption[];
  /** Org models the agent may pin (label + id); empty hides the picker. */
  models: { id: string; label: string; isDefault: boolean }[];
  /** The org's per-step attempt ceiling (org settings; default 10). */
  attemptsCap: number;
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

function notesOf(agent: StoredAgent | undefined | null): ReviewNote[] {
  return parseReviewNotes(agent?.reviewNotes);
}

function newStep(attemptsCap: number): AgentStep {
  return {
    id: randomUUID(),
    name: '',
    instruction: [],
    tool: null,
    // 5 tries by default; a stricter org cap wins.
    maxAttempts: Math.min(5, attemptsCap),
    failureHandling: [],
  };
}

export function AgentBuilder({
  slug,
  tenantId,
  tools,
  otherAgents,
  calendars,
  models,
  attemptsCap,
  existing,
}: AgentBuilderProps) {
  const router = useRouter();
  const [agentId, setAgentId] = useState<string | null>(existing?.id ?? null);
  const [name, setName] = useState(existing?.name ?? '');
  const [steps, setSteps] = useState<AgentStep[]>(existing?.steps.steps ?? [newStep(attemptsCap)]);
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
    reviewNotes: ReviewNote[];
    apiKeys: MintedApiKey[];
    pending: boolean;
  } | null>(null);
  // The edit page's standing "worth checking" panel — the checker's notes
  // on the SAVED version, refreshable on demand.
  const [checkNotes, setCheckNotes] = useState<ReviewNote[]>(notesOf(existing));
  const [checking, setChecking] = useState(false);
  // The "start from a description" box — open by default on create, behind
  // a link on edit (there it REPLACES the current steps, a bigger act).
  const [prose, setProse] = useState('');
  const [proseOpen, setProseOpen] = useState(!existing);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  // The adapter's redacted request summary on provider rejections — shown
  // to the person who clicked Draft (their own request), never logs-only.
  const [draftDetail, setDraftDetail] = useState<string | null>(null);
  // Elapsed-time feedback for the long synchronous draft call: the wait is
  // real model time (the server allows up to 150s), and a bare spinner past
  // ten seconds reads as "hung" — staged messages read as "working".
  const [draftSeconds, setDraftSeconds] = useState(0);
  const [draftMode, setDraftMode] = useState<'create' | 'revise'>('create');
  const [drafted, setDrafted] = useState(false);

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
        setCheckNotes(notesOf(agent));
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

  useEffect(() => {
    if (!drafting) return;
    setDraftSeconds(0);
    const timer = setInterval(() => setDraftSeconds((seconds) => seconds + 1), 1_000);
    return () => clearInterval(timer);
  }, [drafting]);

  const draftStatus = (() => {
    if (draftSeconds < 3) return 'Sending your description to your org’s model…';
    if (draftSeconds < 20)
      return draftMode === 'revise'
        ? 'Revising your steps — applying the change you described…'
        : 'Splitting it into steps and picking the skills…';
    if (draftSeconds < 60)
      return `Still thinking (${draftSeconds}s) — matching skills and details…`;
    return `Still working (${draftSeconds}s) — bigger models can take a few minutes (up to five). Hang tight.`;
  })();

  const draftFromProse = async () => {
    if (drafting || prose.trim().length < 10) return;
    // With real steps present this is a REVISION: the current steps go
    // along as context, the model applies the described change, and
    // untouched steps keep their retry settings. Still confirmed — it
    // rewrites what's on screen.
    const hasRealSteps = steps.some(
      (step) => step.instruction.length > 0 || step.tool !== null || step.name.trim()
    );
    if (
      hasRealSteps &&
      !window.confirm(
        'Revise the current steps based on this description? Steps the change doesn’t touch keep their settings.'
      )
    ) {
      return;
    }
    setDraftMode(hasRealSteps ? 'revise' : 'create');
    setDrafting(true);
    setDraftError(null);
    setDraftDetail(null);
    const result = await sendJsonFull<{ name: string; steps: AgentStep[]; detail?: string }>(
      `/api/tenant/${tenantId}/agents/draft`,
      'POST',
      {
        text: prose,
        ...(hasRealSteps ? { steps: stepsDoc } : {}),
        triggerVars: triggerVariableNames(triggers.map((trigger) => trigger.draft)),
      }
    );
    setDrafting(false);
    if (result.error || !result.data?.steps) {
      setDraftError(result.error ?? 'Drafting failed — try again.');
      if (typeof result.data?.detail === 'string') setDraftDetail(result.data.detail);
      return;
    }
    setSteps(result.data.steps);
    if (!name.trim() && result.data.name) setName(result.data.name);
    setDrafted(true);
    setServerIssues([]);
  };

  const recheck = async () => {
    if (!agentId || checking) return;
    setChecking(true);
    const started = await sendJsonFull(
      `/api/tenant/${tenantId}/agents/${agentId}/describe`,
      'POST'
    );
    if (started.error) {
      setSaveError(started.error);
      setChecking(false);
      return;
    }
    for (let polls = 0; polls < 22; polls += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const result = await getJson<{ agent: StoredAgent }>(
        `/api/tenant/${tenantId}/agents/${agentId}`
      );
      const agent = result.data?.agent;
      if (agent && agent.descriptionStatus !== 'stale') {
        setCheckNotes(notesOf(agent));
        break;
      }
    }
    setChecking(false);
  };

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

  const persist = async (
    withEnabled: boolean,
    options: { refreshDescription?: boolean } = {}
  ): Promise<SaveResponse | null> => {
    setSaveError(null);
    const payload = {
      name,
      steps: stepsDoc,
      triggers,
      enabled: withEnabled,
      llmModelId,
      // Save says "rewrite the summary, I'm about to review it"; the review
      // panel's confirm deliberately does not — see the PUT route.
      ...(options.refreshDescription ? { refreshDescription: true } : {}),
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
      const saved = await persist(enabled, { refreshDescription: true });
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
      {!proseOpen && existing ? (
        <p>
          <button
            type="button"
            onClick={() => setProseOpen(true)}
            className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            ✨ Redraft from a description…
          </button>
        </p>
      ) : null}

      {proseOpen ? (
        <section className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              {existing ? 'Redraft from a description' : 'Start from a description'}
            </h2>
            {existing ? (
              <button
                type="button"
                aria-label="Close"
                onClick={() => setProseOpen(false)}
                className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              >
                ✕
              </button>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
            {existing
              ? 'Describe the change in your own words — add a step, remove one, tweak an instruction, or redo the whole thing. Steps the change doesn’t touch keep their retry settings.'
              : 'Describe the whole thing in your own words — we’ll draft the steps and pick the skills; you review and adjust everything below before saving.'}
          </p>
          <textarea
            value={prose}
            onChange={(event) => setProse(event.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="e.g. When someone messages me about a ticket, look it up in Jira, add their message as a comment, and reply in the thread with what changed."
            className="mt-2 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              disabled={drafting || prose.trim().length < 10}
              onClick={() => void draftFromProse()}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {drafting ? (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-300 border-t-white"
                  />
                  Drafting…
                </>
              ) : drafted ? (
                'Draft again'
              ) : (
                'Draft the steps for me'
              )}
            </button>
            {drafted && !drafting ? (
              <span className="text-xs text-green-700 dark:text-green-400">
                {draftMode === 'revise'
                  ? 'Revised below — steps the change didn’t touch kept their settings.'
                  : 'Drafted below — review every step before saving.'}
              </span>
            ) : null}
            {draftError ? (
              <span className="text-xs text-red-600 dark:text-red-400">{draftError}</span>
            ) : null}
          </div>
          {drafting ? (
            <p aria-live="polite" className="mt-2 text-xs text-gray-600 dark:text-gray-400">
              {draftStatus}
            </p>
          ) : null}
          {draftDetail && !drafting ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                What was sent (content redacted)
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-gray-200 bg-white p-2 font-mono text-[11px] dark:border-gray-800 dark:bg-gray-950">
                {draftDetail}
              </pre>
            </details>
          ) : null}
        </section>
      ) : null}

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

      {agentId ? (
        <section className="rounded-md border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/40">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
              Worth checking
            </h2>
            <button
              type="button"
              disabled={checking}
              onClick={() => void recheck()}
              className="flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:underline disabled:opacity-50 dark:text-amber-300"
            >
              {checking ? (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-amber-300 border-t-amber-700 dark:border-amber-800 dark:border-t-amber-300"
                  />
                  Checking…
                </>
              ) : (
                'Re-check'
              )}
            </button>
          </div>
          {checkNotes.length > 0 ? (
            <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-amber-900 dark:text-amber-200">
              {checkNotes.map((note) => (
                <li key={note.issue}>
                  {note.issue}
                  {note.fix ? (
                    <p className="mt-0.5 text-xs text-amber-700/80 dark:text-amber-300/70">
                      Suggestion: {note.fix}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-amber-800/70 dark:text-amber-200/60">
              Nothing flagged on the last check.
            </p>
          )}
          <p className="mt-2 text-xs text-amber-700/60 dark:text-amber-300/50">
            These look at the last saved version — save your edits, then re-check.
          </p>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-sm font-semibold">When should it run?</h2>
        <TriggerPanel
          triggers={triggers}
          onChange={(next) => {
            setTriggers(next);
            setServerIssues([]);
          }}
          otherAgents={otherAgents}
          calendars={calendars}
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
              attemptsCap={attemptsCap}
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
          onClick={() => setSteps((current) => [...current, newStep(attemptsCap)])}
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
