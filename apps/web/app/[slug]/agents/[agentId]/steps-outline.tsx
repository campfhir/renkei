import React from 'react';
import {
  instructionPreview,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  type AgentStepsDoc,
  type BranchStep,
} from '@renkei/agents';

/**
 * The steps as a readable recipe, branches included: a branch renders as an
 * indigo card with its two paths nested underneath. Numbering is the
 * pre-order ordinal, so it lines up with the run timeline's step order.
 */
export default function StepsOutline({ doc }: { doc: AgentStepsDoc }): React.ReactNode {
  const ordinals = new Map(walkSteps(doc.steps).map((entry) => [entry.node.id, entry.ordinal]));
  return <NodeList nodes={doc.steps} ordinals={ordinals} />;
}

function NodeList({
  nodes,
  ordinals,
}: {
  nodes: AgentStepNode[];
  ordinals: Map<string, number>;
}): React.ReactNode {
  return (
    <ol className="space-y-2">
      {nodes.map((node) => {
        switch (node.kind) {
          case 'branch':
            return <BranchCard key={node.id} branch={node} ordinals={ordinals} />;
          case 'loop':
            return (
              <li
                key={node.id}
                className="rounded-md border border-amber-200 p-3 text-sm dark:border-amber-900"
              >
                <span className="mr-2 font-semibold">{(ordinals.get(node.id) ?? 0) + 1}.</span>
                <span className="font-medium">↻ {node.name}</span>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {node.mode === 'foreach'
                    ? `For each ${node.itemVar} in ${node.itemsVar}`
                    : 'Repeats until its condition holds'}
                  {` — up to ${node.maxIterations}×`}
                  {node.collectVar ? ` — collects into "${node.collectVar}"` : ''}
                </p>
                <div className="mt-2 border-l-2 border-amber-200 pl-3 dark:border-amber-900">
                  <NodeList nodes={node.steps} ordinals={ordinals} />
                </div>
              </li>
            );
          case 'group':
            return (
              <li
                key={node.id}
                className="rounded-md border border-gray-300 p-3 text-sm dark:border-gray-700"
              >
                <span className="mr-2 font-semibold">{(ordinals.get(node.id) ?? 0) + 1}.</span>
                <span className="font-medium">▣ {node.name}</span>
                <div className="mt-2 border-l-2 border-gray-200 pl-3 dark:border-gray-800">
                  <NodeList nodes={node.steps} ordinals={ordinals} />
                </div>
              </li>
            );
          case 'terminal': {
            const wording =
              node.result === 'failure'
                ? 'Fails the run here'
                : node.result === 'stop'
                  ? 'Skips the rest of the run here'
                  : 'Finishes the run here';
            const channels = [
              ...(node.notifyEmail ? ['emails you'] : []),
              ...(node.notifyWebex ? ['sends a WebEx note'] : []),
            ];
            return (
              <li
                key={node.id}
                className="rounded-md border border-rose-200 p-3 text-sm dark:border-rose-900"
              >
                <span className="mr-2 font-semibold">{(ordinals.get(node.id) ?? 0) + 1}.</span>
                <span className="font-medium">⏹ {node.name}</span>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {wording}
                  {channels.length > 0 ? ` — ${channels.join(' and ')}` : ''}
                </p>
                {node.message.length > 0 ? (
                  <p className="mt-1 text-gray-600 dark:text-gray-400">
                    {instructionPreview(node.message)}
                  </p>
                ) : null}
              </li>
            );
          }
          case 'approval': {
            const outcomes: { label: string; path: (typeof node)['onApproved'] }[] = [
              {
                label: node.mode === 'input' ? 'If answered' : 'If approved',
                path: node.onApproved,
              },
              { label: 'If declined', path: node.onDeclined },
              { label: 'If nobody acts in time', path: node.onTimeout },
            ];
            return (
              <li
                key={node.id}
                className="rounded-md border border-sky-200 bg-sky-50/50 p-3 text-sm dark:border-sky-900 dark:bg-sky-950/30"
              >
                <span className="mr-2 font-semibold">{(ordinals.get(node.id) ?? 0) + 1}.</span>
                <span className="font-medium">✋ {node.name}</span>
                <p className="mt-1 text-gray-600 dark:text-gray-400">
                  {instructionPreview(node.message)}
                </p>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Pauses for {node.mode === 'input' ? 'your typed answer' : 'your approval'} — up to{' '}
                  {node.timeoutHours}h{node.saveAs ? ` — saves the answer as “${node.saveAs}”` : ''}
                </p>
                {outcomes.map(({ label, path }) => (
                  <div
                    key={path.id}
                    className="mt-2 border-l-2 border-sky-200 pl-3 dark:border-sky-900"
                  >
                    <p className="mb-1 text-xs font-medium text-sky-700 dark:text-sky-300">
                      {label}: {path.name}
                    </p>
                    {path.steps.length > 0 ? (
                      <NodeList nodes={path.steps} ordinals={ordinals} />
                    ) : (
                      <p className="text-xs italic text-gray-500">(continues below)</p>
                    )}
                  </div>
                ))}
              </li>
            );
          }
          case 'action':
          case undefined:
            return (
              <StepCard key={node.id} step={node} ordinal={(ordinals.get(node.id) ?? 0) + 1} />
            );
          default: {
            const unhandled: never = node;
            throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
          }
        }
      })}
    </ol>
  );
}

function StepCard({ step, ordinal }: { step: ActionStep; ordinal: number }): React.ReactNode {
  return (
    <li className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800">
      <span className="mr-2 font-semibold">{ordinal}.</span>
      <span className="font-medium">{step.name}</span>
      <p className="mt-1 text-gray-600 dark:text-gray-400">
        {instructionPreview(step.instruction)}
      </p>
      {step.failureHandling.some((entry) => entry.action === 'retry') ? (
        <p className="mt-1 text-xs text-gray-500">
          Retries up to {step.maxAttempts}× on handled failures.
        </p>
      ) : null}
      {step.failureHandling.some((entry) => entry.action === 'stop-quiet') ? (
        <p className="mt-1 text-xs text-gray-500">
          Some failure conditions skip the rest of the run silently.
        </p>
      ) : null}
      {step.failureHandling.some(
        (entry) => entry.action === 'continue' || entry.exhausted === 'continue'
      ) ? (
        <p className="mt-1 text-xs text-gray-500">
          Some failure conditions are noted and the run keeps going.
        </p>
      ) : null}
    </li>
  );
}

function BranchCard({
  branch,
  ordinals,
}: {
  branch: BranchStep;
  ordinals: Map<string, number>;
}): React.ReactNode {
  return (
    <li className="rounded-md border border-indigo-200 bg-indigo-50/50 p-3 text-sm dark:border-indigo-900 dark:bg-indigo-950/40">
      <span className="mr-2 font-semibold">{(ordinals.get(branch.id) ?? 0) + 1}.</span>
      <span className="font-medium">Branch: {branch.name}</span>
      <p className="mt-1 text-gray-600 dark:text-gray-400">
        {instructionPreview(branch.condition)}
      </p>
      {branch.paths.map((path, index) => (
        <div
          key={path.id}
          className="mt-2 border-l-2 border-indigo-200 pl-3 dark:border-indigo-900"
        >
          <p className="mb-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">
            {index === 0 ? 'If yes' : 'Otherwise'}: {path.name}
          </p>
          {path.steps.length > 0 ? (
            <NodeList nodes={path.steps} ordinals={ordinals} />
          ) : (
            <p className="text-xs italic text-gray-500">(continues below)</p>
          )}
        </div>
      ))}
    </li>
  );
}
