import { Kysely, sql } from 'kysely';

/**
 * Agents become instructions: the step document (a tree of actions,
 * branches, loops and terminal markers the engine walked node by node) is
 * replaced by a structured instruction prompt and a tool selection, and the
 * agent works out how to reach the goal itself inside hard limits
 * (docs/agents.md). This migration:
 *
 *  1. adds `agents.instructions`, `agents.tools` and
 *     `agents.auto_accept_actions`, and converts every existing step
 *     document into instructions — the plan rendered as a numbered
 *     Approach the agent follows, its tools the ones the steps named (less
 *     the blocked ones). An agent with no `needsApproval` step acted as
 *     written before, so it converts with auto-accept on: its staged
 *     actions are accepted for it wherever the org's policy allows, which
 *     is where its calls used to fire unattended. An agent that gated a
 *     step converts with auto-accept off.
 *  2. keeps the old documents as `legacy_steps` / `legacy_steps_snapshot`
 *     (nullable, unread by this build) so nothing an owner wrote is lost —
 *     a later migration may drop them.
 *  3. adds `agent_runs.definition_snapshot` (what a run executes),
 *     `active_ms` (the active-time clock, which stops while the run waits
 *     on a person) and `resume_failure`, and cancels every run still in
 *     flight: a half-walked step plan cannot be continued as a
 *     conversation. Their waiting cards expire.
 *  4. creates `agent_action_batches` — the staged changes an agent
 *     proposes, which a separate executor runs once accepted.
 */

type StepNode = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): StepNode[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Chip segments → prose: tools by name, values by their name in quotes. */
function segmentsText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((segment) => {
      if (!isRecord(segment)) return '';
      switch (segment.t) {
        case 'text':
          return typeof segment.v === 'string' ? segment.v : '';
        case 'tool':
          return `\`${String(segment.name)}\``;
        case 'var':
          return `“${String(segment.name)}”`;
        case 'date': {
          const amount = Number(segment.amount);
          const unit = String(segment.unit);
          const when =
            amount === 0
              ? `this ${unit}`
              : `${Math.abs(amount)} ${unit}${Math.abs(amount) === 1 ? '' : 's'} ${amount < 0 ? 'ago' : 'from now'}`;
          return `${when}${segment.atTime ? ` at ${String(segment.atTime)}` : ''} (${String(segment.timezone)})`;
        }
        default:
          return '';
      }
    })
    .join('')
    .trim();
}

function toolsOfSegments(value: unknown, into: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const segment of value) {
    if (isRecord(segment) && segment.t === 'tool' && typeof segment.name === 'string') {
      into.add(segment.name);
    }
  }
}

interface Rendered {
  lines: string[];
  tools: Set<string>;
  gated: boolean;
}

function renderNodes(nodes: StepNode[], depth: number, out: Rendered): void {
  const indent = '   '.repeat(depth);
  nodes.forEach((node, index) => {
    const number = `${indent}${index + 1}.`;
    const name = typeof node.name === 'string' && node.name.trim() ? node.name.trim() : 'Step';
    switch (node.kind) {
      case 'branch': {
        out.lines.push(`${number} **${name}** — decide: ${segmentsText(node.condition)}`);
        for (const path of list(node.paths)) {
          out.lines.push(`${indent}   - If “${String(path.name)}”:`);
          renderNodes(list(path.steps), depth + 2, out);
        }
        if (isRecord(node.failurePath)) {
          out.lines.push(`${indent}   - If none of these can be decided:`);
          renderNodes(list(node.failurePath.steps), depth + 2, out);
        }
        toolsOfSegments(node.condition, out.tools);
        return;
      }
      case 'loop': {
        const head =
          node.mode === 'foreach'
            ? `for each “${String(node.itemVar)}” in “${String(node.itemsVar)}” (at most ${String(node.maxIterations)})`
            : `repeat until ${segmentsText(node.condition)} (at most ${String(node.maxIterations)} rounds)`;
        out.lines.push(`${number} **${name}** — ${head}:`);
        renderNodes(list(node.steps), depth + 1, out);
        toolsOfSegments(node.condition, out.tools);
        return;
      }
      case 'group':
        out.lines.push(`${number} **${name}**:`);
        renderNodes(list(node.steps), depth + 1, out);
        return;
      case 'terminal': {
        const message = segmentsText(node.message);
        const verdict =
          node.result === 'failure' ? 'failed' : node.result === 'stop' ? 'nothing_to_do' : 'done';
        out.lines.push(
          `${number} **${name}** — finish the run as “${verdict}”${message ? `: ${message}` : '.'}`
        );
        return;
      }
      default: {
        const instruction = segmentsText(node.instruction);
        const extras: string[] = [];
        if (typeof node.tool === 'string' && node.tool) {
          out.tools.add(node.tool);
          extras.push(`use \`${node.tool}\``);
        }
        if (node.needsApproval === true) {
          out.gated = true;
          extras.push('the owner must accept this change');
        }
        if (typeof node.saveAs === 'string' && node.saveAs) {
          extras.push(`keep the result as “${node.saveAs}”`);
        }
        if (node.onSuccess === 'stop') extras.push('then finish the run');
        if (node.onSuccess === 'stop-quiet') extras.push('then finish quietly');
        toolsOfSegments(node.instruction, out.tools);
        out.lines.push(
          `${number} **${name}** — ${instruction}${extras.length > 0 ? ` (${extras.join('; ')})` : ''}`
        );
        for (const handling of list(node.failureHandling)) {
          toolsOfSegments(handling.guidance, out.tools);
          const what =
            handling.action === 'retry'
              ? `try again${handling.guidance ? `: ${segmentsText(handling.guidance)}` : ''}`
              : handling.action === 'continue'
                ? 'note it and carry on'
                : handling.action === 'stop-quiet'
                  ? 'finish quietly — nothing to do'
                  : 'finish the run as failed';
          out.lines.push(`${indent}   - If it fails with “${String(handling.outcome)}”: ${what}.`);
        }
        if (isRecord(node.onNotApproved)) {
          out.lines.push(`${indent}   - If the owner does not accept it:`);
          renderNodes(list(node.onNotApproved.steps), depth + 2, out);
        }
      }
    }
  });
}

export function instructionsFromSteps(
  steps: unknown,
  description: string | null,
  blockedTools: unknown
): { instructions: string; tools: string[]; gated: boolean } {
  const rendered: Rendered = { lines: [], tools: new Set(), gated: false };
  renderNodes(isRecord(steps) ? list(steps.steps) : [], 0, rendered);
  const blocked = new Set(
    Array.isArray(blockedTools) ? blockedTools.filter((tool) => typeof tool === 'string') : []
  );
  const tools = [...rendered.tools].filter((tool) => !blocked.has(tool));
  const goal = description?.trim() || 'Carry out the procedure under Approach for each run.';
  const instructions = [
    '## Goal',
    '',
    goal,
    '',
    '## Approach',
    '',
    'This agent was converted from a step-by-step plan. Follow it in order; where a step clearly does not apply to this run, skip it, and where a call fails, try another way before giving up.',
    '',
    ...(rendered.lines.length > 0 ? rendered.lines : ['1. (The plan had no steps.)']),
    '',
    '## Tools',
    '',
    ...(tools.length > 0 ? tools.map((tool) => `- \`${tool}\``) : ['- None.']),
    '',
    '## Done when',
    '',
    'Every step above that applies to this run has been carried out.',
  ].join('\n');
  return { instructions, tools, gated: rendered.gated };
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE agents
      ADD COLUMN instructions text NOT NULL DEFAULT '',
      ADD COLUMN tools jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN auto_accept_actions boolean NOT NULL DEFAULT false
  `.execute(db);

  const agents = await sql<{
    id: string;
    steps: unknown;
    description: string | null;
    blocked_tools: unknown;
  }>`SELECT id, steps, description, blocked_tools FROM agents`.execute(db);
  for (const agent of agents.rows) {
    const converted = instructionsFromSteps(agent.steps, agent.description, agent.blocked_tools);
    await sql`
      UPDATE agents
      SET instructions = ${converted.instructions},
          tools = ${JSON.stringify(converted.tools)}::jsonb,
          auto_accept_actions = ${!converted.gated}
      WHERE id = ${agent.id}
    `.execute(db);
  }

  await sql`ALTER TABLE agents RENAME COLUMN steps TO legacy_steps`.execute(db);
  await sql`ALTER TABLE agents ALTER COLUMN legacy_steps DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE agents ALTER COLUMN legacy_steps DROP DEFAULT`.execute(db);

  await sql`
    ALTER TABLE agent_runs
      ADD COLUMN definition_snapshot jsonb,
      ADD COLUMN active_ms bigint NOT NULL DEFAULT 0,
      ADD COLUMN resume_failure text
  `.execute(db);
  await sql`ALTER TABLE agent_runs RENAME COLUMN steps_snapshot TO legacy_steps_snapshot`.execute(db);
  await sql`ALTER TABLE agent_runs ALTER COLUMN legacy_steps_snapshot DROP NOT NULL`.execute(db);

  // In-flight step runs cannot continue as conversations: end them, and
  // retire the cards they wait behind.
  await sql`
    UPDATE actionable_items SET
      status = 'expired', decided_at = NOW(), archived_at = NOW(),
      result = '{"reason":"agent-converted"}'::jsonb, updated_at = NOW()
    WHERE status = 'suggested'
      AND run_id IN (
        SELECT id FROM agent_runs WHERE status IN ('queued', 'running', 'waiting')
      )
  `.execute(db);
  await sql`
    UPDATE agent_runs SET
      status = 'canceled', waiting_until = NULL, finished_at = NOW(), updated_at = NOW(),
      error_kind = 'converted',
      error = 'Canceled when this agent moved from steps to instructions — run it again.'
    WHERE status IN ('queued', 'running', 'waiting')
  `.execute(db);

  await sql`
    CREATE TABLE agent_action_batches (
      id uuid PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      owner_subject varchar(255) NOT NULL,
      -- The turn that staged it: one batch per turn, the duplicate-staging tripwire.
      turn integer NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'proposed',
      summary text NOT NULL,
      actions jsonb NOT NULL,
      results jsonb NOT NULL DEFAULT '[]'::jsonb,
      -- Why a person had to accept it ('owner' | 'high-risk' | 'policy'); null = auto-accepted.
      review_reason varchar(16),
      -- 'person' | 'auto', once accepted.
      accepted_by varchar(16),
      decided_by varchar(255),
      decided_at timestamptz,
      comment text,
      waiting_until timestamptz,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (run_id, turn)
    )
  `.execute(db);
  await sql`CREATE INDEX idx_agent_action_batches_status ON agent_action_batches (status, updated_at)`.execute(
    db
  );
  await sql`CREATE INDEX idx_agent_action_batches_agent ON agent_action_batches (agent_id, created_at DESC)`.execute(
    db
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS agent_action_batches`.execute(db);
  await sql`ALTER TABLE agent_runs RENAME COLUMN legacy_steps_snapshot TO steps_snapshot`.execute(db);
  await sql`UPDATE agent_runs SET steps_snapshot = '{"version":9,"steps":[]}'::jsonb WHERE steps_snapshot IS NULL`.execute(
    db
  );
  await sql`ALTER TABLE agent_runs ALTER COLUMN steps_snapshot SET NOT NULL`.execute(db);
  await sql`
    ALTER TABLE agent_runs
      DROP COLUMN definition_snapshot, DROP COLUMN active_ms, DROP COLUMN resume_failure
  `.execute(db);
  await sql`ALTER TABLE agents RENAME COLUMN legacy_steps TO steps`.execute(db);
  await sql`UPDATE agents SET steps = '{"version":9,"steps":[]}'::jsonb WHERE steps IS NULL`.execute(db);
  await sql`ALTER TABLE agents ALTER COLUMN steps SET NOT NULL`.execute(db);
  await sql`
    ALTER TABLE agents
      DROP COLUMN instructions, DROP COLUMN tools, DROP COLUMN auto_accept_actions
  `.execute(db);
}
