'use client';

/**
 * The builder as a flow chart: triggers are the start node, steps are
 * collapsed nodes on a vertical spine, and whatever is selected gets edited
 * in the side panel (desktop) or a modal (phone) — the canvas shows the
 * whole recipe at a glance, the panel shows one thing's details.
 *
 * Validation runs the SAME @renkei/agents function the server treats as
 * authority, here only for inline hints; the server's answer (422 +
 * issues) renders identically, so the client check being bypassed changes
 * nothing but latency. Save → review overlay with the generated
 * description; enabling is its own deliberate act.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BUILTIN_VARIABLES,
  containsBranch,
  findNodeById,
  flattenActionSteps,
  isBranchStep,
  triggerVariableDescriptors,
  validateAgentDraft,
  walkSteps,
  type AgentStepNode,
  type AgentStepsDoc,
  type ValidationIssue,
} from '@renkei/agents';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import type { MintedApiKey, StoredAgent } from '@/lib/agents/store';
import { parseReviewNotes, type ReviewNote } from '@/lib/agents/notes';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { toToolOptions, toVariableOptions, type VariableOption } from './options';
import { FlowCanvas, type BuilderSelection } from './flow-canvas';
import {
  insertNode,
  issuesByNode,
  moveSibling,
  newBranch,
  newStep,
  removeNode,
  updateNode,
  type InsertLocation,
} from './flow-tree';
import { EditorPanel } from './editor-panel';
import { StepEditor } from './step-editor';
import { BranchEditor } from './branch-editor';
import { summaryOf, type AgentChoice, type BuilderTrigger } from './trigger-node';
import { TriggerChooser, TriggerEditor } from './trigger-editor';
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
  const [steps, setSteps] = useState<AgentStepNode[]>(
    existing?.steps.steps ?? [newStep(attemptsCap)]
  );
  const [triggers, setTriggers] = useState<BuilderTrigger[]>(
    existing?.triggers.map((trigger) => ({
      id: trigger.id,
      draft: trigger.draft,
      enabled: trigger.enabled,
      keyHint: trigger.keyHint,
      lastError: trigger.lastError,
    })) ?? []
  );
  const [selection, setSelection] = useState<BuilderSelection | null>(null);
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
    const hasRealSteps = walkSteps(steps).some(({ node }) =>
      isBranchStep(node)
        ? node.condition.length > 0 || node.name.trim().length > 0
        : node.instruction.length > 0 || node.tool !== null || node.name.trim().length > 0
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
    const result = await sendJsonFull<{ name: string; steps: AgentStepNode[]; detail?: string }>(
      `/api/tenant/${tenantId}/agents/draft`,
      'POST',
      {
        text: prose,
        ...(hasRealSteps ? { steps: stepsDoc } : {}),
        // Names WITH their catalog descriptions, so the drafting model knows
        // what each trigger variable is and how to use it.
        triggerVars: triggerVariableDescriptors(triggers.map((trigger) => trigger.draft)).map(
          ({ name: varName, description }) => ({ name: varName, description })
        ),
      }
    );
    setDrafting(false);
    if (result.error || !result.data?.steps) {
      setDraftError(result.error ?? 'Drafting failed — try again.');
      if (typeof result.data?.detail === 'string') setDraftDetail(result.data.detail);
      return;
    }
    setSteps(result.data.steps);
    setSelection(null);
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

  const stepsDoc: AgentStepsDoc = useMemo(
    // The server recomputes the version on save; matching its rule here
    // keeps the client draft identical to what will persist.
    () => ({ version: containsBranch(steps) ? 2 : 1, steps }),
    [steps]
  );
  const ordinals = useMemo(
    () => new Map(walkSteps(steps).map((entry) => [entry.node.id, entry.ordinal])),
    [steps]
  );
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
    const fromTriggers = triggerVariableDescriptors(draft.triggers);
    const fromSteps = flattenActionSteps(steps).flatMap((step) =>
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
    for (const { node } of walkSteps(steps)) {
      const segments = isBranchStep(node)
        ? node.condition
        : [...node.instruction, ...node.failureHandling.flatMap((h) => h.guidance ?? [])];
      for (const segment of segments) {
        if (segment.t === 'var' && !knownVarNames.has(segment.name)) used.add(segment.name);
      }
    }
    return used;
  }, [steps, knownVarNames]);

  const clientIssues = useMemo(() => validateAgentDraft(draft, tools), [draft, tools]);
  const issues = serverIssues.length > 0 ? serverIssues : clientIssues;
  // Exact prefix match: `steps.1` must NOT claim `steps.10.instruction`.
  const issuesAt = (prefix: string) =>
    issues
      .filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`))
      .map((issue) => issue.message);

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

  const issueMap = useMemo(() => issuesByNode(steps, issues), [steps, issues]);

  const selectedNode =
    selection?.type === 'step' ? (findNodeById(steps, selection.id)?.node ?? null) : null;
  const selectedTrigger =
    selection?.type === 'trigger' ? (triggers[selection.index] ?? null) : null;

  const changeNode = (id: string, next: AgentStepNode) => {
    setSteps((current) => updateNode(current, id, () => next));
  };

  const insertAt = (location: InsertLocation, kind: 'step' | 'branch') => {
    const node = kind === 'branch' ? newBranch() : newStep(attemptsCap);
    setSteps((current) => insertNode(current, location, node));
    setSelection({ type: 'step', id: node.id });
    setServerIssues([]);
  };

  const moveNode = (id: string, direction: -1 | 1) => {
    setSteps((current) => moveSibling(current, id, direction));
  };

  const deleteNode = (id: string) => {
    const found = findNodeById(steps, id);
    if (
      found &&
      isBranchStep(found.node) &&
      found.node.paths.some((path) => path.steps.length > 0) &&
      !window.confirm('Delete this branch and every step inside its paths?')
    ) {
      return;
    }
    setSteps((current) => removeNode(current, id));
    setSelection((current) => (current?.type === 'step' && current.id === id ? null : current));
  };

  const panelTitle = (() => {
    if (selection?.type === 'new-trigger') return 'Add a trigger';
    if (selectedTrigger) return summaryOf(selectedTrigger.draft, otherAgents);
    if (selectedNode) {
      const ordinal = (ordinals.get(selectedNode.id) ?? 0) + 1;
      if (isBranchStep(selectedNode)) return selectedNode.name.trim() || 'Branch';
      return selectedNode.name.trim() || `Step ${ordinal}`;
    }
    return '';
  })();

  const panelWide = selectedTrigger?.draft.kind === 'schedule';

  return (
    <div data-wide-page className="pb-24 lg:pb-4">
      <div className="lg:flex lg:items-start lg:gap-6">
        {/* Agent settings: model, name, worth-checking, and (desktop only)
            the save bar. Plain stacked content on mobile — first, above the
            flow, no sidebar chrome. On desktop it docks as the SECOND
            column (lg:order-last puts it there regardless of DOM position,
            which has to come first here for mobile's stacking order) and
            swaps out via lg:hidden for the node/trigger editor while
            something is selected — that editor takes this same slot.
            Nothing here needs to hide on mobile: a selected node opens its
            own modal, floating over this content rather than replacing it. */}
        <div
          className={`space-y-4 lg:order-last lg:w-[26rem] lg:max-h-[calc(100vh-7rem)] lg:shrink-0 lg:self-start lg:overflow-y-auto lg:rounded-lg lg:border lg:border-gray-200 lg:bg-white lg:p-4 lg:sticky lg:top-4 lg:dark:border-gray-800 lg:dark:bg-gray-950 ${selection ? 'lg:hidden' : ''}`}
        >
          {models.length > 0 ? (
            <div>
              <label
                className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400"
                htmlFor="agent-model"
              >
                Model
              </label>
              <select
                id="agent-model"
                value={llmModelId ?? ''}
                onChange={(event) => setLlmModelId(event.target.value || null)}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-900"
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
            </div>
          ) : null}

          <div>
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
          </div>

          {agentId ? (
            <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/40">
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
            </div>
          ) : null}

          {/* Desktop-only: mobile keeps the fixed bottom bar below, always
              reachable without first scrolling the sidebar into view. */}
          <div className="hidden border-t border-gray-100 pt-3 dark:border-gray-800 lg:block">
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
              {issues.length > 0
                ? `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix before saving`
                : enabled
                  ? 'This agent is on.'
                  : 'Saved agents start turned off — you review, then turn them on.'}
            </p>
            {saveError ? (
              <p className="mb-2 text-xs text-red-600 dark:text-red-400">{saveError}</p>
            ) : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  router.push(agentId ? `/${slug}/agents/${agentId}` : `/${slug}/agents`)
                }
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

        <div className="min-w-0 flex-1 space-y-6">
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
            <FlowCanvas
              nodes={steps}
              ordinals={ordinals}
              triggers={triggers}
              otherAgents={otherAgents}
              selection={selection}
              issuesFor={(nodeId) => issueMap.get(nodeId)?.length ?? 0}
              triggerIssues={issuesAt('triggers')}
              stepsIssues={issues
                .filter((issue) => issue.path === 'steps')
                .map((issue) => issue.message)}
              onSelect={setSelection}
              onInsert={insertAt}
              onMove={moveNode}
              onDelete={deleteNode}
            />
          </section>
        </div>

        {selection?.type === 'new-trigger' ? (
          <EditorPanel title="Add a trigger" onClose={() => setSelection(null)}>
            <TriggerChooser
              otherAgents={otherAgents}
              onChoose={(draftTrigger) => {
                setTriggers((current) => [...current, { draft: draftTrigger, enabled: true }]);
                setSelection({ type: 'trigger', index: triggers.length });
                setServerIssues([]);
              }}
            />
          </EditorPanel>
        ) : null}

        {selectedTrigger && selection?.type === 'trigger' ? (
          <EditorPanel
            title={panelTitle}
            width={panelWide ? 'wide' : 'normal'}
            onClose={() => setSelection(null)}
            footer={
              <button
                type="button"
                onClick={() => {
                  const index = selection.index;
                  setTriggers((current) => current.filter((_, at) => at !== index));
                  setSelection(null);
                }}
                className="text-sm text-red-600 hover:underline dark:text-red-400"
              >
                Remove this trigger
              </button>
            }
          >
            <TriggerEditor
              trigger={selectedTrigger}
              otherAgents={otherAgents}
              calendars={calendars}
              onChange={(draftTrigger) => {
                const index = selection.index;
                setTriggers((current) =>
                  current.map((entry, at) =>
                    at === index ? { ...entry, draft: draftTrigger } : entry
                  )
                );
              }}
            />
          </EditorPanel>
        ) : null}

        {selectedNode ? (
          <EditorPanel title={panelTitle} onClose={() => setSelection(null)}>
            {isBranchStep(selectedNode) ? (
              <BranchEditor
                branch={selectedNode}
                onChange={(next) => changeNode(selectedNode.id, next)}
                variables={variables}
                invalidVars={invalidVars}
                issues={issueMap.get(selectedNode.id) ?? []}
              />
            ) : (
              <StepEditor
                step={selectedNode}
                ordinal={(ordinals.get(selectedNode.id) ?? 0) + 1}
                attemptsCap={attemptsCap}
                onChange={(next) => changeNode(selectedNode.id, next)}
                tools={toolOptions}
                toolDescriptors={toolDescriptors}
                variables={variables}
                invalidVars={invalidVars}
                issues={issueMap.get(selectedNode.id) ?? []}
              />
            )}
          </EditorPanel>
        ) : null}
      </div>

      {/* Mobile-only: desktop's save bar lives in the sidebar above. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95 lg:hidden">
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
              // Editing an existing agent: back to its overview, not the flat
              // list. Drafting a brand-new one (agentId still null): nothing
              // to show yet, so the list is the only place to go.
              onClick={() =>
                router.push(agentId ? `/${slug}/agents/${agentId}` : `/${slug}/agents`)
              }
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
