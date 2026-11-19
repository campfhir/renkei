'use client';

/**
 * A code project's pipeline builder, the "Pipeline" tab of its app under
 * Deployments (/deployments/[projectId]/pipeline; the layout draws the
 * app's header and tabs):
 * what was found in the repository, the pipeline as rows of the
 * organization's blocks — on every pull request, then each environment's
 * branch — or the file it writes, the checks before it runs, and Save and
 * "Open a pull request". One column on a phone; the checks beside the rows
 * on a wide screen. Editors get the assistant in the app's floating dock
 * (components/assistant-dock), which tailors the blocks to the source. What
 * the page decides is pipeline-builder.model.ts.
 */

import { useCallback, useEffect, useReducer, useRef, type Dispatch } from 'react';
import Link from 'next/link';
import ExternalLink from '@/components/external-link';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import {
  blockChoices,
  builderReducer,
  canOpenPullRequest,
  canSave,
  checks,
  environmentFormProblems,
  fileLines,
  fileStatus,
  fileText,
  initialBuilder,
  ownBlocks,
  partCards,
  pullRequestNote,
  saveRequest,
  stepEditor,
  type BuilderAction,
  type BuilderData,
  type BuilderState,
  type PartCard,
  type StepCard,
} from './pipeline-builder.model';
import { AssistantDockPanel, useAssistantDock } from '@/components/assistant-dock/assistant-dock';
import PipelineAssistant from './pipeline-assistant';
import {
  askRequest,
  assistantReducer,
  buildingBlockRequest,
  initialAssistant,
  reuseQuestion,
  type AssistantAnswer,
  type AssistantMessage,
} from './pipeline-assistant.model';
import {
  cardClass,
  inputClass,
  linkButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './pipeline-parts';

const KIND_LABEL: Record<string, string> = {
  build: 'Build',
  test: 'Test',
  package: 'Package',
  deploy: 'Deploy',
  check: 'Check',
};
const CHECK_LOOK = {
  ok: {
    mark: '✓',
    label: 'Passes',
    className: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  },
  warn: {
    mark: '!',
    label: 'Warning',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
  fail: {
    mark: '×',
    label: 'Needs fixing',
    className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  },
};
const chip =
  'inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300';

export default function PipelineBuilder({
  projectId,
  host,
  operator,
}: {
  projectId: string;
  host: 'bitbucket' | 'github';
  /** Offers making one of the project's blocks a building block for every project. */
  operator: boolean;
}) {
  const [state, dispatch] = useReducer(builderReducer, initialBuilder);
  const [assistant, assistantDispatch] = useReducer(assistantReducer, initialAssistant);
  const nextId = useRef(0);
  const dock = useAssistantDock();
  const url = `/api/code/projects/${projectId}/pipeline-builder`;

  const load = useCallback(
    async (notice?: string, live: () => boolean = () => true) => {
      const result = await getJson<BuilderData>(url);
      if (!live()) return;
      if (result.data)
        dispatch({ type: 'loaded', data: result.data, ...(notice ? { notice } : {}) });
      else dispatch({ type: 'failed', error: result.error ?? 'The pipeline could not be read.' });
    },
    [url]
  );
  useEffect(() => {
    // A load an unmount (or React's second dev-mode run) superseded is dropped.
    let live = true;
    void load(undefined, () => live);
    return () => {
      live = false;
    };
  }, [load]);

  const save = async () => {
    const body = saveRequest(state);
    if (!body) return;
    dispatch({ type: 'sent', busy: 'save' });
    const result = await sendJsonFull<{ problems?: string[] }>(url, 'PUT', body);
    if (result.error) {
      dispatch({ type: 'failed', error: result.error, problems: result.data?.problems ?? [] });
      return;
    }
    dispatch({ type: 'saved' });
  };

  const openPullRequest = async () => {
    const body = saveRequest(state);
    if (!body) return;
    dispatch({ type: 'sent', busy: 'pull-request' });
    const result = await sendJsonFull<{ url?: string; updated?: boolean; problems?: string[] }>(
      `${url}/pull-request`,
      'POST',
      body
    );
    if (result.error || !result.data?.url) {
      dispatch({
        type: 'failed',
        error: result.error ?? 'The pull request could not be opened.',
        problems: result.data?.problems ?? [],
      });
      return;
    }
    dispatch({
      type: 'pullRequestOpened',
      url: result.data.url,
      updated: Boolean(result.data.updated),
    });
    // What the host has now: the file on the branch is the pull request's, not the branch's yet.
    await load(
      result.data.updated
        ? 'The pull request has the new file.'
        : 'Pull request opened with the pipeline.'
    );
  };

  const ask = async (text: string) => {
    if (!state.spec) return;
    const id = `m${(nextId.current += 1)}`;
    const asked = assistantReducer(assistant, { type: 'asked', id, text });
    if (asked === assistant) return;
    assistantDispatch({ type: 'asked', id, text });
    const result = await sendJsonFull<AssistantAnswer & { problems?: string[] }>(
      `${url}/assistant`,
      'POST',
      askRequest(asked, state.spec)
    );
    if (result.error || !result.data) {
      assistantDispatch({
        type: 'failed',
        error: result.error ?? 'The assistant did not answer.',
        problems: result.data?.problems ?? [],
      });
      return;
    }
    assistantDispatch({
      type: 'answered',
      id: `m${(nextId.current += 1)}`,
      answer: result.data,
    });
  };

  const apply = (message: AssistantMessage) => {
    if (!message.proposal) return;
    dispatch({ type: 'applyProposal', spec: message.proposal.spec });
    assistantDispatch({ type: 'applied', id: message.id });
  };

  const saveBlock = async (message: AssistantMessage) => {
    const body = buildingBlockRequest(assistant, message.id);
    if (!body) return;
    assistantDispatch({ type: 'savingBlock', id: message.id });
    const result = await sendJsonFull<{ id?: string }>('/api/admin/ci-blocks', 'POST', body);
    if (result.error || !result.data?.id) {
      assistantDispatch({
        type: 'blockFailed',
        id: message.id,
        error: result.error ?? 'The building block was not saved.',
      });
      return;
    }
    assistantDispatch({ type: 'blockSaved', id: message.id, blockId: result.data.id });
  };

  const data = state.data;
  const hostName = host === 'github' ? 'GitHub' : 'Bitbucket';
  const blockName = (key: string) => data?.blocks.find((b) => b.key === key)?.name ?? key;

  return (
    <div>
      <div className="space-y-4">
        {state.busy === 'load' && !data ? (
          <p className="text-sm text-gray-500">Reading the repository…</p>
        ) : null}
        {!data && state.error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        ) : null}

        {data ? (
          <>
            <section aria-label="Found in this repository" className={`${cardClass} space-y-2`}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold">Found in this repository:</span>
                {data.found.length > 0 ? (
                  data.found.map((thing) => (
                    <span key={thing} className={chip}>
                      {thing}
                    </span>
                  ))
                ) : (
                  <span className="text-gray-500">no language the blocks know</span>
                )}
                <span className={chip}>{fileStatus(state)}</span>
              </div>
              <p className="text-xs text-gray-500">
                {data.suggested
                  ? 'The pipeline below was suggested from the organization’s blocks. Change it here; nothing reaches the repository until you open the pull request.'
                  : 'The pipeline saved for this project. Nothing reaches the repository until you open the pull request.'}{' '}
                Renkei never deploys: merging to an environment’s branch starts {hostName}’s
                pipeline, which does.
              </p>
              {data.unread.length > 0 ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Not read from {hostName}, so not checked: {data.unread.join(' · ')}
                </p>
              ) : null}
            </section>

            {state.notice ? (
              <p
                role="status"
                className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300"
              >
                {state.notice}
                {state.pullRequest ? (
                  <>
                    {' '}
                    <ExternalLink href={state.pullRequest.url} className="font-medium underline">
                      Open it on {hostName}
                    </ExternalLink>
                  </>
                ) : null}
              </p>
            ) : null}
            {state.error ? (
              <div
                role="alert"
                className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300"
              >
                <p>{state.error}</p>
                {state.problems.length > 0 ? (
                  <ul className="mt-1 list-disc pl-5">
                    {state.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {data.canEdit ? (
              // The assistant floats above the page, in the app's dock.
              <AssistantDockPanel id="pipeline-assistant" title="Pipeline assistant">
                <PipelineAssistant
                  state={assistant}
                  dispatch={assistantDispatch}
                  spec={state.spec}
                  blockName={blockName}
                  operator={operator}
                  onAsk={(text) => void ask(text)}
                  onApply={apply}
                  onSaveBlock={(message) => void saveBlock(message)}
                />
              </AssistantDockPanel>
            ) : null}

            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="min-w-0 space-y-4">
                <div
                  role="tablist"
                  aria-label="Pipeline view"
                  className="flex gap-4 border-b border-gray-200 dark:border-gray-800"
                >
                  {(['builder', 'file'] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      role="tab"
                      aria-selected={state.view === view}
                      onClick={() => dispatch({ type: 'view', view })}
                      className={`-mb-px border-b-2 px-1 pb-2 text-sm font-semibold ${
                        state.view === view
                          ? 'border-blue-600 text-blue-700 dark:text-blue-400'
                          : 'border-transparent text-gray-600 dark:text-gray-400'
                      }`}
                    >
                      {view === 'builder' ? 'Builder' : 'The file it writes'}
                    </button>
                  ))}
                </div>
                {state.view === 'builder' ? (
                  <>
                    <Rows state={state} dispatch={dispatch} />
                    <OwnBlocks
                      state={state}
                      operator={operator}
                      busy={assistant.busy}
                      onReuse={(block) => {
                        dock.open();
                        void ask(reuseQuestion(block));
                      }}
                    />
                  </>
                ) : (
                  <FileView state={state} />
                )}
              </div>

              <aside className="min-w-0 space-y-4">
                <ChecksPanel state={state} dispatch={dispatch} projectId={projectId} host={host} />
                <section className={`${cardClass} space-y-2`} aria-label="Open a pull request">
                  <button
                    type="button"
                    disabled={!canOpenPullRequest(state)}
                    onClick={() => void openPullRequest()}
                    className={`${primaryButtonClass} w-full`}
                  >
                    {state.busy === 'pull-request'
                      ? 'Opening…'
                      : data.pullRequestUrl
                        ? 'Update the pull request'
                        : 'Open a pull request with the pipeline'}
                  </button>
                  <button
                    type="button"
                    disabled={!canSave(state)}
                    onClick={() => void save()}
                    className={`${secondaryButtonClass} w-full disabled:opacity-50`}
                  >
                    {state.busy === 'save' ? 'Saving…' : 'Save without opening one'}
                  </button>
                  <p className="text-xs text-gray-500">{pullRequestNote(state)}</p>
                  {data.pullRequestUrl && !state.pullRequest ? (
                    <p className="text-xs">
                      <ExternalLink
                        href={data.pullRequestUrl}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        The last pull request
                      </ExternalLink>
                    </p>
                  ) : null}
                </section>
              </aside>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Rows({ state, dispatch }: { state: BuilderState; dispatch: Dispatch<BuilderAction> }) {
  const canEdit = Boolean(state.data?.canEdit);
  const editor = stepEditor(state);
  return (
    <div className="space-y-4">
      {partCards(state).map((part) => (
        <section
          key={part.part ?? 'pull-requests'}
          aria-label={part.part === null ? 'On every pull request' : `Environment ${part.part}`}
          className={`${cardClass} space-y-3`}
        >
          <PartHeader part={part} canEdit={canEdit} dispatch={dispatch} />
          <ol className="flex flex-wrap items-stretch gap-2">
            {part.steps.map((step, index) => (
              <li
                key={`${step.key}-${index}`}
                className="flex min-w-0 flex-1 basis-56 items-stretch gap-2"
              >
                {index > 0 ? (
                  <span aria-hidden className="self-center text-gray-400">
                    →
                  </span>
                ) : null}
                <StepTile
                  step={step}
                  selected={
                    state.selected?.part === step.ref.part &&
                    state.selected.index === step.ref.index
                  }
                  dispatch={dispatch}
                />
              </li>
            ))}
            {canEdit ? (
              <li className="flex">
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'openPicker', part: part.part })}
                  className="min-h-11 rounded-lg border border-dashed border-gray-400 px-3 text-xs font-semibold text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-900"
                >
                  + Add block
                </button>
              </li>
            ) : null}
          </ol>
          {state.picking && state.picking.part === part.part ? (
            <Picker state={state} part={part.part} dispatch={dispatch} />
          ) : null}
          {editor && editor.ref.part === part.part ? (
            <Editor editor={editor} canEdit={canEdit} dispatch={dispatch} />
          ) : null}
        </section>
      ))}
      {canEdit ? <EnvironmentForm state={state} dispatch={dispatch} /> : null}
    </div>
  );
}

function PartHeader({
  part,
  canEdit,
  dispatch,
}: {
  part: PartCard;
  canEdit: boolean;
  dispatch: Dispatch<BuilderAction>;
}) {
  if (part.part === null || !canEdit) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-sm font-semibold">{part.title}</h2>
        <p className="text-xs text-gray-500">{part.detail}</p>
      </div>
    );
  }
  const environment = part.part;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-semibold">On merge to</h2>
      <input
        aria-label={`Branch that deploys ${environment}`}
        value={part.branch ?? ''}
        onChange={(e) => dispatch({ type: 'setBranch', environment, branch: e.target.value })}
        className="w-40 rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
      />
      <p className="text-xs text-gray-500">{part.detail}</p>
      <button
        type="button"
        onClick={() => dispatch({ type: 'removeEnvironment', environment })}
        className={`ml-auto ${linkButtonClass} text-red-600 dark:text-red-400`}
      >
        Remove {environment}
      </button>
    </div>
  );
}

function StepTile({
  step,
  selected,
  dispatch,
}: {
  step: StepCard;
  selected: boolean;
  dispatch: Dispatch<BuilderAction>;
}) {
  return (
    <button
      type="button"
      aria-expanded={selected}
      aria-label={`${step.name}, ${step.kind ? KIND_LABEL[step.kind] : 'missing'}`}
      onClick={() => dispatch({ type: 'select', step: selected ? null : step.ref })}
      className={`flex min-w-0 flex-1 flex-col gap-1 rounded-lg border p-3 text-left ${
        selected
          ? 'border-blue-500 ring-1 ring-blue-500'
          : step.missing
            ? 'border-red-300 dark:border-red-800'
            : 'border-gray-300 hover:border-gray-400 dark:border-gray-700'
      }`}
    >
      <span className="text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
        {step.kind ? KIND_LABEL[step.kind] : 'Missing'}
        {step.own ? (
          <span className="ml-2 normal-case text-violet-700 dark:text-violet-400">
            this project’s own
          </span>
        ) : null}
        {step.newer ? (
          <span className="ml-2 normal-case text-amber-700 dark:text-amber-400">
            v{step.newer} published
          </span>
        ) : null}
      </span>
      <span className="text-sm font-semibold">{step.name}</span>
      {step.target ? (
        <span className="text-xs text-gray-600 dark:text-gray-400">
          target <span className="font-mono">{step.target}</span>
        </span>
      ) : null}
      <span className="text-xs break-words text-gray-500">{step.summary}</span>
    </button>
  );
}

function Picker({
  state,
  part,
  dispatch,
}: {
  state: BuilderState;
  part: string | null;
  dispatch: Dispatch<BuilderAction>;
}) {
  const choices = blockChoices(state, part);
  return (
    <div className="space-y-2 rounded-md bg-gray-50 p-3 dark:bg-gray-900">
      <div className="flex items-center">
        <p className="text-xs font-semibold">
          Add a block {part === null ? 'to pull requests' : `to ${part}`}
        </p>
        <button
          type="button"
          onClick={() => dispatch({ type: 'closePicker' })}
          className={`ml-auto ${linkButtonClass}`}
        >
          Close
        </button>
      </div>
      {choices.length === 0 ? (
        <p className="text-xs text-gray-500">
          No published blocks yet.{' '}
          <Link
            href="/admin/ci-blocks"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            Building blocks
          </Link>
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {choices.map((choice) => (
            <li key={choice.key}>
              <button
                type="button"
                onClick={() => dispatch({ type: 'addStep', part, block: choice.key })}
                className="flex w-full flex-col items-start gap-0.5 rounded-md border border-gray-200 bg-white p-2 text-left hover:border-blue-400 dark:border-gray-700 dark:bg-gray-950"
              >
                <span className="text-[11px] font-semibold text-gray-500 uppercase">
                  {KIND_LABEL[choice.kind]}
                  {choice.own ? (
                    <span className="ml-2 normal-case text-violet-700 dark:text-violet-400">
                      this project’s own
                    </span>
                  ) : null}
                </span>
                <span className="text-sm font-medium">{choice.name}</span>
                {choice.description ? (
                  <span className="text-xs text-gray-500">{choice.description}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Editor({
  editor,
  canEdit,
  dispatch,
}: {
  editor: NonNullable<ReturnType<typeof stepEditor>>;
  canEdit: boolean;
  dispatch: Dispatch<BuilderAction>;
}) {
  const ref = editor.ref;
  return (
    <fieldset
      disabled={!canEdit}
      aria-label={`${editor.name}, ${editor.where}`}
      className="min-w-0 space-y-3 rounded-md bg-gray-50 p-3 dark:bg-gray-900"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold">{editor.name}</p>
        <p className="text-xs text-gray-500">{editor.where}</p>
        {editor.newer ? (
          <button
            type="button"
            onClick={() => dispatch({ type: 'updateStep', step: ref })}
            className={linkButtonClass}
          >
            Use v{editor.newer}
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
        {editor.targets ? (
          <label className="flex flex-col gap-1 text-xs font-semibold text-gray-700 dark:text-gray-300">
            Target
            <select
              value={editor.target}
              onChange={(e) => dispatch({ type: 'setTarget', step: ref, target: e.target.value })}
              className={inputClass}
            >
              <option value="">Pick a target</option>
              {editor.targets.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {editor.fields.map((field) => (
          <label
            key={field.name}
            className="flex flex-col gap-1 text-xs font-semibold text-gray-700 dark:text-gray-300"
          >
            <span className="font-mono">
              {field.name}
              {field.required ? '' : ' (optional)'}
            </span>
            <input
              value={field.value}
              placeholder={field.placeholder}
              type={field.type === 'number' ? 'number' : 'text'}
              inputMode={field.type === 'url' ? 'url' : undefined}
              onChange={(e) =>
                dispatch({ type: 'setInput', step: ref, name: field.name, value: e.target.value })
              }
              className={inputClass}
            />
            {field.hint ? <span className="font-normal text-gray-500">{field.hint}</span> : null}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!editor.canMoveBack}
          onClick={() => dispatch({ type: 'moveStep', step: ref, by: -1 })}
          className={linkButtonClass}
        >
          ← Earlier
        </button>
        <button
          type="button"
          disabled={!editor.canMoveOn}
          onClick={() => dispatch({ type: 'moveStep', step: ref, by: 1 })}
          className={linkButtonClass}
        >
          Later →
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'removeStep', step: ref })}
          className={`${linkButtonClass} text-red-600 dark:text-red-400`}
        >
          Remove step
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'select', step: null })}
          className={`ml-auto ${linkButtonClass}`}
        >
          Done
        </button>
      </div>
    </fieldset>
  );
}

function EnvironmentForm({
  state,
  dispatch,
}: {
  state: BuilderState;
  dispatch: Dispatch<BuilderAction>;
}) {
  const form = state.environmentForm;
  if (!form) {
    return (
      <button
        type="button"
        onClick={() => dispatch({ type: 'openEnvironmentForm' })}
        className="min-h-11 w-full rounded-lg border border-dashed border-gray-400 px-3 text-sm font-semibold text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-900"
      >
        + Add an environment (a branch that deploys somewhere)
      </button>
    );
  }
  const problems = environmentFormProblems(state);
  return (
    <form
      aria-label="Add an environment"
      onSubmit={(e) => {
        e.preventDefault();
        dispatch({ type: 'addEnvironment' });
      }}
      className={`${cardClass} space-y-3`}
    >
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-gray-700 dark:text-gray-300">
          Environment
          <input
            value={form.name}
            onChange={(e) =>
              dispatch({ type: 'environmentField', patch: { name: e.target.value } })
            }
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-gray-700 dark:text-gray-300">
          Deploys on merge to
          <input
            value={form.branch}
            onChange={(e) =>
              dispatch({ type: 'environmentField', patch: { branch: e.target.value } })
            }
            className={`${inputClass} font-mono`}
          />
        </label>
      </div>
      {problems.length > 0 ? (
        <ul role="alert" className="list-disc pl-5 text-xs text-red-700 dark:text-red-400">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <button type="submit" disabled={problems.length > 0} className={primaryButtonClass}>
          Add environment
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'closeEnvironmentForm' })}
          className={secondaryButtonClass}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The blocks the assistant wrote for this project, and making one reusable (operators). */
function OwnBlocks({
  state,
  operator,
  busy,
  onReuse,
}: {
  state: BuilderState;
  operator: boolean;
  busy: boolean;
  onReuse: (block: { key: string; name: string }) => void;
}) {
  const blocks = ownBlocks(state);
  if (blocks.length === 0) return null;
  return (
    <section aria-label="This project’s own blocks" className={`${cardClass} space-y-2`}>
      <h2 className="text-sm font-semibold">This project’s own blocks</h2>
      <p className="text-xs text-gray-500">
        Written for this repository and kept with its pipeline, not in the organization’s building
        blocks.
      </p>
      <ul className="space-y-2">
        {blocks.map((block) => (
          <li
            key={block.key}
            className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md bg-gray-50 p-2 dark:bg-gray-900"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {block.name}{' '}
                <span className="font-mono text-xs font-normal text-gray-500">
                  {block.key} · {KIND_LABEL[block.kind]}
                </span>
              </p>
              {block.description ? (
                <p className="text-xs text-gray-500">{block.description}</p>
              ) : null}
              <p className="text-xs text-gray-500">
                {block.usedIn.length > 0
                  ? `Used in ${block.usedIn.join(', ')}`
                  : 'Not used in any row; add it from a row’s picker.'}
              </p>
            </div>
            {operator && state.data?.canEdit ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onReuse(block)}
                className={linkButtonClass}
              >
                Make it reusable
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function FileView({ state }: { state: BuilderState }) {
  const file = fileText(state);
  const lines = fileLines(state);
  if (!state.data || !file) return null;
  return (
    <section aria-label="The file it writes" className={`${cardClass} space-y-2`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-mono text-sm font-semibold">{state.data.file}</h2>
        <p className="text-xs text-gray-500">
          {state.data.facts.existingFile === null ? 'new file' : 'replaces the file on the branch'}
          {lines !== null ? ` · ${lines} lines` : ''}
        </p>
      </div>
      <p className="text-xs text-gray-500">
        The builder writes the whole file each time; change the pipeline here, not the file.
      </p>
      {file.ok ? (
        <pre className="max-h-[36rem] overflow-auto rounded-md bg-gray-50 p-3 font-mono text-xs leading-5 dark:bg-gray-900">
          {file.value}
        </pre>
      ) : (
        <div role="alert" className="text-sm text-red-700 dark:text-red-400">
          <p>The file can be written once these are fixed:</p>
          <ul className="mt-1 list-disc pl-5">
            {file.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ChecksPanel({
  state,
  dispatch,
  projectId,
  host,
}: {
  state: BuilderState;
  dispatch: Dispatch<BuilderAction>;
  projectId: string;
  host: 'bitbucket' | 'github';
}) {
  const list = checks(state);
  const variablesHref = `/deployments/${projectId}/runs`;
  return (
    <section aria-labelledby="before-it-runs" className={`${cardClass} space-y-2`}>
      <h2 id="before-it-runs" className="text-sm font-semibold">
        Before it runs
      </h2>
      <p className="text-xs text-gray-500">
        Checked against {host === 'github' ? 'GitHub' : 'Bitbucket'}, your targets and the blocks,
        as you change it.
      </p>
      <ul className="space-y-2">
        {list.map((check, index) => {
          const look = CHECK_LOOK[check.state];
          return (
            <li key={`${check.text}-${index}`} className="flex items-start gap-2 text-sm">
              <span
                aria-hidden
                className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${look.className}`}
              >
                {look.mark}
              </span>
              <span className="min-w-0 break-words">
                <span className="sr-only">{look.label}: </span>
                {check.text}
                {check.fix === 'targets' ? (
                  <>
                    {' '}
                    <Link href="/admin/ci-targets" className={linkButtonClass}>
                      See targets
                    </Link>
                  </>
                ) : check.fix === 'variables' ? (
                  <>
                    {' '}
                    <Link href={variablesHref} className={linkButtonClass}>
                      Set it
                    </Link>
                  </>
                ) : check.fix === 'update' && check.at && state.data?.canEdit ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() =>
                        dispatch({
                          type: 'updateStep',
                          step: { part: check.at!.environment, index: check.at!.index },
                        })
                      }
                      className={linkButtonClass}
                    >
                      Update
                    </button>
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
