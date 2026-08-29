/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { applyStepPatch, resolveLocation } from './patch-steps';
import type { AgentStepNode, AgentStepsDoc } from '@renkei/agents';

const step = (id: string, name: string): AgentStepNode =>
  ({
    id,
    name,
    instruction: [{ t: 'text', v: name }],
    tool: null,
    maxAttempts: 1,
    failureHandling: [],
  }) as AgentStepNode;

const loop = (id: string, body: AgentStepNode[]): AgentStepNode =>
  ({
    id,
    kind: 'loop',
    mode: 'foreach',
    name: 'the loop',
    itemsVar: 'items',
    itemVar: 'item',
    maxIterations: 10,
    steps: body,
  }) as AgentStepNode;

const doc = (steps: AgentStepNode[]): AgentStepsDoc => ({ version: 3, steps }) as AgentStepsDoc;

const names = (nodes: AgentStepNode[]): string[] => nodes.map((n) => n.name);

describe('resolveLocation', () => {
  const nodes = [step('a', 'A'), step('b', 'B')];

  it('insists on exactly one anchor', () => {
    expect(resolveLocation(nodes, {})).toEqual({
      ok: false,
      error: 'a position is required: after, before, intoPath, intoContainer or atTop',
    });
    const both = resolveLocation(nodes, { after: 'a', before: 'b' });
    expect(both.ok).toBe(false);
  });

  it('names an anchor it cannot find, rather than guessing a position', () => {
    const result = resolveLocation(nodes, { after: 'nope' });
    expect(result).toEqual({ ok: false, error: 'no step with id "nope" to insert after' });
  });
});

describe('applyStepPatch', () => {
  it('slots a step between two others', () => {
    const result = applyStepPatch(doc([step('a', 'A'), step('b', 'B')]), [
      { op: 'insert', node: step('mid', 'MID'), at: { after: 'a' } },
    ]);

    expect(result.ok).toBe(true);
    expect(result.ok && names(result.steps.steps)).toEqual(['A', 'MID', 'B']);
  });

  it('inserts before an anchor too', () => {
    const result = applyStepPatch(doc([step('a', 'A'), step('b', 'B')]), [
      { op: 'insert', node: step('mid', 'MID'), at: { before: 'b' } },
    ]);
    expect(result.ok && names(result.steps.steps)).toEqual(['A', 'MID', 'B']);
  });

  it('slots into the anchor’s OWN list, not the top level', () => {
    // The anchor is inside a loop; "after it" must mean inside the loop.
    const tree = doc([loop('L', [step('x', 'X')]), step('after', 'AFTER')]);
    const result = applyStepPatch(tree, [
      { op: 'insert', node: step('y', 'Y'), at: { after: 'x' } },
    ]);

    expect(result.ok).toBe(true);
    const body = result.ok ? (result.steps.steps[0] as { steps: AgentStepNode[] }).steps : [];
    expect(names(body)).toEqual(['X', 'Y']);
    expect(result.ok && names(result.steps.steps)).toEqual(['the loop', 'AFTER']);
  });

  it('leaves every untouched step exactly as it was', () => {
    // The whole point: no transcription, so nothing else can drift.
    const original = doc([step('a', 'A'), step('b', 'B')]);
    const before = JSON.parse(JSON.stringify(original.steps[0]));
    const result = applyStepPatch(original, [{ op: 'remove', id: 'b' }]);

    expect(result.ok && result.steps.steps[0]).toEqual(before);
  });

  it('moves a step into a container', () => {
    const tree = doc([loop('L', []), step('a', 'A')]);
    const result = applyStepPatch(tree, [{ op: 'move', id: 'a', at: { intoContainer: 'L' } }]);

    expect(result.ok).toBe(true);
    const body = result.ok ? (result.steps.steps[0] as { steps: AgentStepNode[] }).steps : [];
    expect(names(body)).toEqual(['A']);
    expect(result.ok && result.steps.steps).toHaveLength(1);
  });

  it('refuses to move a container inside itself', () => {
    const tree = doc([loop('L', [step('x', 'X')])]);
    const result = applyStepPatch(tree, [{ op: 'move', id: 'L', at: { after: 'x' } }]);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('not allowed');
  });

  it('refuses a replacement that changes the id', () => {
    // Run history and retry settings anchor to ids.
    const result = applyStepPatch(doc([step('a', 'A')]), [
      { op: 'replace', id: 'a', node: step('different', 'A2') },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('must stay "a"');
  });

  it('refuses an insert whose id already exists', () => {
    const result = applyStepPatch(doc([step('a', 'A')]), [
      { op: 'insert', node: step('a', 'DUP'), at: { atTop: true } },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('already in this agent');
  });

  it('applies nothing when a later operation fails', () => {
    const result = applyStepPatch(doc([step('a', 'A')]), [
      { op: 'insert', node: step('b', 'B'), at: { atTop: true } },
      { op: 'remove', id: 'ghost' },
    ]);

    // All-or-nothing: a half-applied patch is a shape nobody described.
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('operation 2 (remove)');
  });

  it('lets a later operation see an earlier one', () => {
    const result = applyStepPatch(doc([step('a', 'A')]), [
      { op: 'insert', node: loop('L', []), at: { after: 'a' } },
      { op: 'move', id: 'a', at: { intoContainer: 'L' } },
    ]);

    expect(result.ok).toBe(true);
    expect(result.ok && result.steps.steps).toHaveLength(1);
  });

  it('rejects an empty patch rather than silently saving nothing', () => {
    expect(applyStepPatch(doc([step('a', 'A')]), [])).toEqual({
      ok: false,
      error: 'no operations were given',
    });
  });
});
