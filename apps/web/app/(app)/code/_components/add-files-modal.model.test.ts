/**
 * The Add files dialog (add-files-modal.model.ts), as a person using it
 * would describe it. What the queue does with the batch is
 * components/uploads/upload-queue.model.test.ts; the browser spec
 * (code-uploads.spec.ts) sends one batch into the checkout for real.
 */

import {
  addFilesReducer,
  addLabel,
  batchPlan,
  canAdd,
  checkoutPath,
  countLabel,
  initialAddFiles,
  listedAs,
  type AddFilesAction,
  type AddFilesState,
  type PickedFile,
} from './add-files-modal.model';

const f = (name: string, size = 10): PickedFile => ({ name, size });

const run = (actions: AddFilesAction[], from: AddFilesState = initialAddFiles()) =>
  actions.reduce(addFilesReducer, from);

describe('choosing', () => {
  it('starts on the checkout, with no folder and nothing picked, Add off', () => {
    const state = initialAddFiles();
    expect(state).toMatchObject({ destination: 'checkout', folder: '', files: [] });
    expect(canAdd(state)).toBe(false);
    expect(addLabel(state)).toBe('Add to repository');
    expect(countLabel(state)).toBeNull();
  });

  it('a second pick adds to the list, and a name already there is not added twice', () => {
    const state = run([
      { type: 'picked', files: [f('a.md'), f('b.md')] },
      { type: 'picked', files: [f('b.md'), f('c.md'), f('c.md')] },
    ]);
    expect(state.files.map((file) => file.name)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('Remove takes that one file off', () => {
    const a = f('a.md');
    const state = run([
      { type: 'picked', files: [a, f('b.md')] },
      { type: 'removed', file: a },
    ]);
    expect(state.files.map((file) => file.name)).toEqual(['b.md']);
  });

  it('lists each file at the path it will land at under the folder', () => {
    const state = run([{ type: 'folder', folder: 'docs' }]);
    expect(listedAs(state, 'guide.md')).toBe('docs/guide.md');
    const artifacts = run([{ type: 'destination', destination: 'artifacts' }], state);
    expect(listedAs(artifacts, 'guide.md')).toBe('guide.md');
  });

  it('a folder’s spaces and slashes at either end do not change the path', () => {
    expect(checkoutPath('  /docs/assets/ ', 'a.png')).toBe('docs/assets/a.png');
    expect(checkoutPath('', 'a.png')).toBe('a.png');
    expect(checkoutPath(' / ', 'a.png')).toBe('a.png');
  });

  it('the button says where and, past one, how many', () => {
    const three = run([{ type: 'picked', files: [f('a'), f('b'), f('c')] }]);
    expect(addLabel(three)).toBe('Add to repository (3)');
    expect(countLabel(three)).toBe('3 files');
    const one = run([
      { type: 'destination', destination: 'artifacts' },
      { type: 'picked', files: [f('a')] },
    ]);
    expect(addLabel(one)).toBe('Add to artifacts');
    expect(countLabel(one)).toBe('1 file');
  });
});

describe('adding', () => {
  it('into the checkout: each file labelled with its path under the folder', () => {
    const state = run([
      { type: 'folder', folder: 'docs' },
      { type: 'picked', files: [f('guide.md'), f('empty.md', 0)] },
    ]);
    const plan = batchPlan(state, 'Billing');
    expect(plan.title).toBe('Add files to the checkout of Billing');
    expect(plan.destination).toBe('checkout');
    expect(plan.items.map(({ label, path }) => ({ label, path }))).toEqual([
      { label: 'docs/guide.md', path: 'docs/guide.md' },
      { label: 'docs/empty.md', path: 'docs/empty.md' },
    ]);
  });

  it('into the artifacts: each file labelled as going there', () => {
    const state = run([
      { type: 'folder', folder: 'docs' },
      { type: 'destination', destination: 'artifacts' },
      { type: 'picked', files: [f('kept-note.md')] },
    ]);
    const plan = batchPlan(state, 'Billing');
    expect(plan.title).toBe('Add artifacts to Billing');
    expect(plan.items[0]!.label).toBe('kept-note.md → artifacts');
  });

  it('Add shows the batch’s table and empties the list; Add more goes back to choosing', () => {
    const started = run([
      { type: 'picked', files: [f('a')] },
      { type: 'started', batchId: 'batch-1' },
      { type: 'filter', filter: 'failed' },
    ]);
    expect(started).toMatchObject({ batchId: 'batch-1', files: [], filter: 'failed' });
    const more = run([{ type: 'addMore' }], started);
    expect(more).toMatchObject({ batchId: null, filter: 'all' });
  });
});
