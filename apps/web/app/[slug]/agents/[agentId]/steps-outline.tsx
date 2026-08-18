import React from 'react';
import {
  instructionPreview,
  isBranchStep,
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
      {nodes.map((node) =>
        isBranchStep(node) ? (
          <BranchCard key={node.id} branch={node} ordinals={ordinals} />
        ) : (
          <StepCard key={node.id} step={node} ordinal={(ordinals.get(node.id) ?? 0) + 1} />
        )
      )}
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
