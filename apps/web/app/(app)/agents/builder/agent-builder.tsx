'use client';

/**
 * The agent builder: an agent is its instructions and the tools it may
 * use. There is no plan to draw — the agent works out how to reach its
 * goal on each run, inside the org's hard limits — so the builder is a
 * document editor: the structured instructions, the tool selection, when it
 * runs, and the few switches around it.
 *
 * What the builder decides — what a draft fills in, whether Save is on,
 * what Save and "Draft it for me" send, what a refused save leaves on
 * screen — is agent-builder.model.ts (tested in node); this component makes
 * the calls, runs the timers and renders.
 *
 * Validation runs the SAME @renkei/agents function the server treats as
 * authority, here only for inline hints; the server's answer (422 +
 * issues) renders identically, so the client check being bypassed changes
 * nothing but latency. Save → the overview page; enabling is its own
 * deliberate act there.
 */

import { useEffect, useMemo, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { INSTRUCTION_SECTIONS, MAX_INSTRUCTIONS_CHARS } from '@renkei/agents';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import type { StoredAgent } from '@/lib/agents/store';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { EditorPanel } from './editor-panel';
import RemoveButton from '@/components/remove-button';
import { GuardrailsPanel } from './guardrails-panel';
import { FieldIssues, fieldClass } from './field-issues';
import { TriggerList, summaryOf, type AgentChoice } from './trigger-node';
import { TriggerChooser, TriggerEditor } from './trigger-editor';
import type { CalendarOption } from './schedule-picker';
import { SaveConfirmPanel } from './review-panel';
import { ToolPicker } from './tool-picker';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import { clientLogger } from '@/lib/client-logger';
import {
  autoAcceptNote,
  builderReducer,
  canDraft,
  canSave,
  clientIssuesOf,
  defaultModelLabel,
  draftButtonLabel,
  draftRequestOf,
  draftStatus,
  hasSection,
  initBuilder,
  instructionIssuesOf,
  issuesAt as issuesAtOf,
  isUsableDraft,
  overviewHref,
  saveAsksFirst,
  saveLabel,
  saveRequestOf,
  saveSummary as saveSummaryOf,
  selectedTriggerOf,
  shownIssues,
  triggerValuesOf,
  type ActApprovalPolicy,
  type SaveResponse,
} from './agent-builder.model';

export interface AgentBuilderProps {
  tools: ToolDescriptor[];
  /** The caller's other agents (for agent-finished triggers). */
  otherAgents: AgentChoice[];
  /** The org's holiday calendars (for schedule blackouts). */
  calendars: CalendarOption[];
  /** Org models the agent may pin (label + id); empty hides the picker. */
  models: { id: string; label: string; isDefault: boolean }[];
  /** The org's hard limits on every run. */
  runLimits: { minutes: number; toolCalls: number };
  /** When the org makes a person accept staged actions anyway. */
  actApprovalPolicy: ActApprovalPolicy;
  /** Present in edit mode. */
  existing?: StoredAgent;
}

/** The zone a drafted schedule with none stated is read in: the person's own. */
function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function AgentBuilder({
  tools,
  otherAgents,
  calendars,
  models,
  runLimits,
  actApprovalPolicy,
  existing,
}: AgentBuilderProps) {
  const router = useRouter();
  // The builder's tour targets (lib/coach-marks/tours/workspace.ts).
  const nameAnchor = useCoachAnchor('builder-name');
  const canvasAnchor = useCoachAnchor('builder-canvas');
  const saveAnchor = useCoachAnchor('builder-save');
  const [state, dispatch] = useReducer(builderReducer, existing, initBuilder);
  const {
    agentId,
    enabled,
    name,
    instructions,
    tools: selectedTools,
    triggers,
    selection,
    llmModelId,
    guardrails,
    canAskQuestions,
    autoAcceptActions,
    saving,
    saveError,
    saveModal,
    checkNotes,
    checking,
    prose,
    proseOpen,
    drafting,
    draftError,
    draftDetail,
    draftMode,
    draftId,
    pendingDraft,
    drafted,
    draftQuestions,
    draftNotes,
  } = state;

  /** Watch a running draft — two seconds; the job outlives this page. */
  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const result = await getJson<{
        draft?: {
          status: string;
          result?: Record<string, unknown> | null;
          error?: string | null;
          errorDetail?: string | null;
        };
      }>(`/api/agents/draft/${draftId}`);
      if (cancelled) return;
      const draft = result.data?.draft;
      if (!draft || draft.status === 'queued' || draft.status === 'running') return;

      clearInterval(timer);
      if (draft.status === 'failed' || !draft.result) {
        clientLogger.warn('agents/builder', 'drafting failed', draft.error ?? undefined, {
          draftId,
          status: draft.status,
        });
        dispatch({
          type: 'draftFailed',
          error: draft.error ?? null,
          detail: draft.errorDetail ?? null,
        });
        return;
      }
      dispatch({ type: 'draftArrived', result: draft.result, localTimezone: localTimezone() });
      if (!isUsableDraft(draft.result)) {
        clientLogger.error('agents/builder', 'draft result has an unrecognised shape', undefined, {
          draftId,
        });
        return;
      }
      // Taken, so it is not offered again on the next open.
      void fetch(`/api/agents/draft/${draftId}/consume`, { method: 'POST' });
    }, 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [draftId]);

  /** Offer a draft that finished while this page was closed — never apply it unasked. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      const result = await getJson<{ draft?: { id: string; createdAt: string } | null }>(
        `/api/agents/draft${query}`
      );
      if (cancelled || !result.data?.draft) return;
      const { id, createdAt } = result.data.draft;
      dispatch({ type: 'pendingDraftFound', draft: { id, createdAt } });
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    if (!drafting) return;
    const timer = setInterval(() => dispatch({ type: 'draftTick' }), 1_000);
    return () => clearInterval(timer);
  }, [drafting]);

  const loadPendingDraft = async () => {
    const waiting = pendingDraft;
    if (!waiting) return;
    const result = await getJson<{ draft?: { result?: Record<string, unknown> | null } }>(
      `/api/agents/draft/${waiting.id}`
    );
    const draftResult = result.data?.draft?.result ?? null;
    dispatch({ type: 'pendingDraftLoaded', result: draftResult, localTimezone: localTimezone() });
    if (!isUsableDraft(draftResult)) {
      clientLogger.warn('agents/builder', 'pending draft could not be loaded', undefined, {
        draftId: waiting.id,
      });
      return;
    }
    void fetch(`/api/agents/draft/${waiting.id}/consume`, { method: 'POST' });
  };

  const draftFromProse = async () => {
    if (!canDraft(state)) return;
    const { revising, body } = draftRequestOf(state);
    if (
      revising &&
      !window.confirm('Revise the current instructions and tools based on this description?')
    ) {
      return;
    }
    dispatch({ type: 'draftStarted', mode: revising ? 'revise' : 'create' });
    const result = await sendJsonFull<{ draftId?: string }>(`/api/agents/draft`, 'POST', body);
    if (result.error || !result.data?.draftId) {
      dispatch({ type: 'draftStartFailed', error: result.error ?? null });
      return;
    }
    dispatch({ type: 'draftQueued', draftId: result.data.draftId });
  };

  const recheck = async () => {
    if (!agentId || checking) return;
    dispatch({ type: 'recheckStarted' });
    const started = await sendJsonFull(`/api/agents/${agentId}/describe`, 'POST');
    if (started.error) {
      dispatch({ type: 'recheckFailed', error: started.error });
      return;
    }
    for (let polls = 0; polls < 22; polls += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const result = await getJson<{ agent: StoredAgent }>(`/api/agents/${agentId}`);
      const agent = result.data?.agent;
      if (agent && agent.descriptionStatus !== 'stale') {
        dispatch({ type: 'recheckDone', agent });
        return;
      }
    }
    dispatch({ type: 'recheckDone', agent: null });
  };

  const clientIssues = useMemo(
    () => clientIssuesOf(state, tools),
    // The check reads only the agent's own fields, not the drafting clock.
    [
      name,
      instructions,
      selectedTools,
      triggers,
      enabled,
      llmModelId,
      guardrails,
      canAskQuestions,
      autoAcceptActions,
      tools,
    ]
  );
  const issues = shownIssues(state, clientIssues);
  const issuesAt = (prefix: string) => issuesAtOf(issues, prefix);
  const instructionIssues = instructionIssuesOf(state, issues);
  const triggerValues = useMemo(() => triggerValuesOf(state), [triggers]);

  /** Persist and finish: navigate to the overview, or show minted keys. */
  const persistAndFinish = async () => {
    dispatch({ type: 'saveSent' });
    const { url, method, body } = saveRequestOf(state);
    const result = await sendJsonFull<SaveResponse>(url, method, body);
    if (result.status === 422 && result.data?.issues) {
      dispatch({ type: 'saveRefused', issues: result.data.issues });
      return;
    }
    if (result.error || !result.data) {
      dispatch({ type: 'saveFailed', error: result.error ?? null });
      return;
    }
    const saved = result.data;
    dispatch({ type: 'saved', response: saved });
    if ((saved.apiKeys ?? []).length > 0) return;
    // `saving` stays on until the overview page takes over.
    router.push(overviewHref(saved.agentId ?? saved.agent?.id ?? agentId));
  };

  const handleSave = () => {
    if (saveAsksFirst(state)) {
      dispatch({ type: 'confirmOpened' });
      return;
    }
    void persistAndFinish();
  };

  const selectedTrigger = selectedTriggerOf(state);
  const saveDisabled = !canSave(state, clientIssues);

  const editorPanels = (
    <>
      {selection?.type === 'new-trigger' ? (
        <EditorPanel title="Add a trigger" onClose={() => dispatch({ type: 'panelClosed' })}>
          <TriggerChooser
            otherAgents={otherAgents}
            onChoose={(draftTrigger) => dispatch({ type: 'triggerChosen', draft: draftTrigger })}
          />
        </EditorPanel>
      ) : null}

      {selectedTrigger && selection?.type === 'trigger' ? (
        <EditorPanel
          title={summaryOf(selectedTrigger.draft, otherAgents)}
          onClose={() => dispatch({ type: 'panelClosed' })}
          headerAction={
            <RemoveButton
              label="Remove trigger"
              onClick={() => dispatch({ type: 'triggerRemoved' })}
            />
          }
        >
          <TriggerEditor
            trigger={selectedTrigger}
            otherAgents={otherAgents}
            calendars={calendars}
            onChange={(draftTrigger) => dispatch({ type: 'triggerEdited', draft: draftTrigger })}
          />
        </EditorPanel>
      ) : null}
    </>
  );

  const prosePanel = (
    <>
      {!proseOpen && existing ? (
        <p>
          <button
            type="button"
            onClick={() => dispatch({ type: 'proseOpened' })}
            className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            ✨ Revise from a description…
          </button>
        </p>
      ) : null}

      {proseOpen ? (
        <section className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              {existing ? 'Revise from a description' : 'Describe it'}
            </h2>
            {existing ? (
              <button
                type="button"
                aria-label="Close"
                onClick={() => dispatch({ type: 'proseClosed' })}
                className="rounded p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
              >
                ✕
              </button>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
            {existing
              ? 'Describe the change in your own words — the instructions and tools are revised to match; you review before saving.'
              : 'Say what you want the agent to do — we’ll write the instructions and pick the tools from the ones you have. You review and adjust everything before saving.'}
          </p>
          <textarea
            value={prose}
            onChange={(event) => dispatch({ type: 'proseChanged', value: event.target.value })}
            rows={4}
            maxLength={8000}
            aria-label="Describe the agent"
            placeholder="e.g. When someone emails me about a broken login, find or file the Jira ticket, comment with what they said, and reply to them with the ticket number."
            className="mt-2 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!canDraft(state)}
              onClick={() => void draftFromProse()}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {drafting ? (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-300 border-t-white"
                  />
                  {draftButtonLabel(state)}
                </>
              ) : (
                draftButtonLabel(state)
              )}
            </button>
            {drafted && !drafting ? (
              <span className="text-xs text-green-700 dark:text-green-400">
                {draftMode === 'revise'
                  ? 'Revised — review the instructions and tools before saving.'
                  : 'Drafted — review the instructions and tools before saving.'}
              </span>
            ) : null}
            {draftError ? (
              <span role="alert" className="text-xs text-red-600 dark:text-red-400">
                {draftError}
              </span>
            ) : null}
          </div>
          {drafting ? (
            <p aria-live="polite" className="mt-2 text-xs text-gray-600 dark:text-gray-400">
              {draftStatus(state)}
            </p>
          ) : null}
          {pendingDraft && !drafting ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-blue-300 bg-blue-50 p-2 text-xs dark:border-blue-800 dark:bg-blue-950">
              <span className="text-blue-800 dark:text-blue-200">
                A draft you started earlier is ready.
              </span>
              <button
                type="button"
                onClick={() => void loadPendingDraft()}
                className="rounded-md bg-blue-600 px-2 py-1 font-medium text-white hover:bg-blue-700"
              >
                Load it
              </button>
              <button
                type="button"
                onClick={() => dispatch({ type: 'pendingDraftDismissed' })}
                className="text-blue-700 hover:underline dark:text-blue-300"
              >
                Not now
              </button>
            </div>
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
          {draftQuestions.length > 0 && !drafting ? (
            <div className="mt-3 rounded-md border border-blue-300 bg-white p-3 dark:border-blue-800 dark:bg-gray-950">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
                The draft needs your input
              </h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm">
                {draftQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                Rather than guessing, the draft left these open. Add the answers to your description
                and draft again — or write them into the instructions yourself.
              </p>
            </div>
          ) : null}
          {draftNotes.length > 0 && !drafting ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-gray-600 dark:text-gray-400">
              {draftNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </>
  );

  const saveSummary = saveSummaryOf(state, issues);

  return (
    <div data-wide-page className="pb-24 lg:pb-4">
      <div className="lg:flex lg:items-start lg:gap-6">
        {/* The right rail: agent settings, or — while a trigger is open —
            its editor, with Save pinned outside the scroll. Plain stacked
            content on mobile. */}
        <div className="lg:sticky lg:top-4 lg:order-last lg:flex lg:max-h-[calc(100vh-7rem)] lg:w-[26rem] lg:shrink-0 lg:flex-col lg:self-start lg:rounded-lg lg:border lg:border-gray-200 lg:bg-white lg:dark:border-gray-800 lg:dark:bg-gray-950">
          <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:p-4">
            <div className={`space-y-6 lg:space-y-4 ${selection ? 'lg:hidden' : ''}`}>
              <div {...nameAnchor}>
                <label className="mb-1 block text-sm font-medium" htmlFor="agent-name">
                  Name it
                </label>
                <input
                  id="agent-name"
                  className={fieldClass(issuesAt('name').length > 0)}
                  aria-invalid={issuesAt('name').length > 0 || undefined}
                  value={name}
                  maxLength={200}
                  placeholder="e.g. Ticket from urgent email"
                  onChange={(event) => dispatch({ type: 'nameChanged', value: event.target.value })}
                />
                <FieldIssues messages={issuesAt('name')} />
              </div>

              {prosePanel}

              <section
                aria-label="Run limits"
                className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400"
              >
                Each run: up to <strong>{runLimits.toolCalls} tool calls</strong> and{' '}
                <strong>{runLimits.minutes} minutes</strong> of active time — waiting on you doesn’t
                count. The agent stops as soon as its goal is met.
              </section>

              <div className="space-y-3">
                <div className="flex items-start gap-2">
                  <input
                    id="agent-can-ask-questions"
                    type="checkbox"
                    className="mt-0.5"
                    checked={canAskQuestions}
                    onChange={(event) =>
                      dispatch({
                        type: 'flagChanged',
                        flag: 'canAskQuestions',
                        value: event.target.checked,
                      })
                    }
                  />
                  <label htmlFor="agent-can-ask-questions" className="text-sm">
                    <span className="font-medium">Can ask me questions</span>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      The agent may pause and ask you something instead of guessing. Its clock stops
                      while it waits.
                    </p>
                  </label>
                </div>
                <div className="flex items-start gap-2">
                  <input
                    id="agent-auto-accept"
                    type="checkbox"
                    className="mt-0.5"
                    checked={autoAcceptActions}
                    onChange={(event) =>
                      dispatch({
                        type: 'flagChanged',
                        flag: 'autoAcceptActions',
                        value: event.target.checked,
                      })
                    }
                  />
                  <label htmlFor="agent-auto-accept" className="text-sm">
                    <span className="font-medium">Accept proposed actions automatically</span>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      The agent never changes anything itself — it proposes a batch of actions, and
                      a separate process carries them out once accepted. With this on, you skip the
                      card. {autoAcceptNote(actApprovalPolicy)}
                    </p>
                  </label>
                </div>
              </div>

              <GuardrailsPanel
                guardrails={guardrails}
                onGuardrailsChange={(next) => dispatch({ type: 'guardrailsChanged', value: next })}
                issues={issuesAt('guardrails')}
              />

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
                    onChange={(event) =>
                      dispatch({ type: 'modelChanged', llmModelId: event.target.value || null })
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-900"
                  >
                    <option value="">{defaultModelLabel(models)}</option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {agentId ? (
                <div className="rounded-md border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900 dark:bg-amber-950/40">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                      Worth checking
                    </h2>
                    <button
                      type="button"
                      disabled={checking}
                      onClick={() => void recheck()}
                      className="text-xs font-medium text-amber-700 hover:underline disabled:opacity-50 dark:text-amber-300"
                    >
                      {checking ? 'Checking…' : 'Re-check'}
                    </button>
                  </div>
                  {checkNotes.length > 0 ? (
                    <ul className="mt-3 list-disc space-y-3 pl-5 text-sm text-amber-900 dark:text-amber-200">
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
                  <p className="mt-3 text-xs text-amber-700/60 dark:text-amber-300/50">
                    These look at the last saved version — save your edits, then re-check.
                  </p>
                </div>
              ) : null}
            </div>

            {editorPanels}
          </div>

          <div className="hidden shrink-0 border-t border-gray-100 p-4 pt-3 dark:border-gray-800 lg:block">
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{saveSummary}</p>
            {saveError && !saveModal ? (
              <p
                role="alert"
                className="mb-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
              >
                Not saved — {saveError}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => router.push(overviewHref(agentId))}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saveDisabled}
                className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                {...saveAnchor}
              >
                {saveLabel(state)}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-8 min-w-0 flex-1 space-y-6 lg:mt-0">
          <section
            {...canvasAnchor}
            aria-label="Instructions editor"
            className="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">
                <label htmlFor="agent-instructions">Instructions</label>
              </h2>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {instructions.length.toLocaleString()} / {MAX_INSTRUCTIONS_CHARS.toLocaleString()}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              Tell the agent what to achieve and how you’d go about it. It decides the exact calls
              on each run, and tries another way when something fails.
            </p>
            <div className="mt-3 gap-4 xl:flex">
              <textarea
                id="agent-instructions"
                value={instructions}
                onChange={(event) =>
                  dispatch({ type: 'instructionsChanged', value: event.target.value })
                }
                rows={22}
                spellCheck
                aria-invalid={instructionIssues.length > 0 || undefined}
                className={`${fieldClass(instructionIssues.length > 0)} min-h-[24rem] font-mono text-xs leading-relaxed xl:flex-1`}
              />
              <aside
                aria-label="Instruction sections"
                className="mt-3 shrink-0 space-y-2 text-xs xl:mt-0 xl:w-60"
              >
                <p className="font-semibold text-gray-500 dark:text-gray-400">Sections</p>
                <ul className="space-y-2">
                  {INSTRUCTION_SECTIONS.map((section) => {
                    const present = hasSection(instructions, section.heading);
                    return (
                      <li key={section.heading}>
                        <span className="flex items-center gap-1.5">
                          <span
                            aria-hidden="true"
                            className={
                              present ? 'text-green-600' : 'text-gray-300 dark:text-gray-600'
                            }
                          >
                            {present ? '✓' : '○'}
                          </span>
                          <span className="font-medium">{section.heading}</span>
                          {!present ? (
                            <button
                              type="button"
                              onClick={() =>
                                dispatch({ type: 'sectionAdded', heading: section.heading })
                              }
                              className="ml-auto text-blue-600 hover:underline dark:text-blue-400"
                            >
                              Add
                            </button>
                          ) : null}
                        </span>
                        <span className="block pl-4 text-gray-500 dark:text-gray-400">
                          {section.asks}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {triggerValues.length > 0 ? (
                  <div className="border-t border-gray-100 pt-2 dark:border-gray-800">
                    <p className="font-semibold text-gray-500 dark:text-gray-400">
                      Each run is handed
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {triggerValues.map((value) => (
                        <li key={value.name} title={value.description}>
                          <code className="text-[11px]">{value.name}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </aside>
            </div>
            <FieldIssues messages={instructionIssues} />
          </section>

          <ToolPicker
            tools={tools}
            selected={selectedTools}
            onChange={(next) => dispatch({ type: 'toolsChanged', tools: next })}
            issues={issuesAt('tools')}
          />

          <TriggerList
            triggers={triggers}
            otherAgents={otherAgents}
            selectedIndex={selection?.type === 'trigger' ? selection.index : null}
            issues={issuesAt('triggers')}
            onSelect={(index) => dispatch({ type: 'triggerOpened', index })}
            onAdd={() => dispatch({ type: 'triggerAddOpened' })}
          />
        </div>
      </div>

      {/* Mobile-only: desktop's save bar lives in the rail above. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95 lg:hidden">
        {saveError && !saveModal ? (
          <p
            role="alert"
            className="mx-auto mb-2 w-full max-w-6xl rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
          >
            Not saved — {saveError}
          </p>
        ) : null}
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
          <p className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400">{saveSummary}</p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => router.push(overviewHref(agentId))}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saveDisabled}
              className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {saveLabel(state)}
            </button>
          </div>
        </div>
      </div>

      {saveModal ? (
        <SaveConfirmPanel
          stage={saveModal.stage}
          apiKeys={saveModal.stage === 'keys' ? saveModal.apiKeys : []}
          saving={saving}
          saveError={saveError}
          onSave={() => void persistAndFinish()}
          onKeepEditing={() => dispatch({ type: 'modalClosed' })}
          onDone={() => router.push(overviewHref(agentId))}
        />
      ) : null}
    </div>
  );
}
