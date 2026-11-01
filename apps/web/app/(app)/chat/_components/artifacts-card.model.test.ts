/**
 * A project's Artifacts card (artifacts-card.model.ts), as a person on
 * the project's page would describe it. These were the rules
 * code-project-artifacts.spec.ts and artifacts.spec.ts walked by
 * pressing: ten at a time, the pager's ends, a detach on the last page,
 * the pager gone once everything fits, the counts under the list, and a
 * second press on remove sending nothing. The specs keep the card drawn
 * on the real page, its phone fit, and one detach reaching the server.
 */

import {
  ARTIFACTS_PAGE_SIZE,
  attachedLabel,
  budgetLine,
  cardPage,
  cardReducer,
  detachSends,
  initialCard,
  listedFiles,
  uploadLabel,
  type CardAction,
  type CardFile,
  type CardState,
} from './artifacts-card.model';

const files = (count: number, mode: CardFile['mode'] = 'on_demand'): CardFile[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `notes-${String(index + 1).padStart(2, '0')}`,
    mode,
  }));

const run = (actions: CardAction[], from: CardState = initialCard) =>
  actions.reduce(cardReducer, from);

describe('a page at a time', () => {
  it('lists ten, says which ten of how many, and holds Previous at the start', () => {
    const view = cardPage(files(12), 1);
    expect(ARTIFACTS_PAGE_SIZE).toBe(10);
    expect(view.shown).toHaveLength(10);
    expect(view.shown[0].id).toBe('notes-01');
    expect(view.shown[9].id).toBe('notes-10');
    expect(view.range).toBe('1–10 of 12');
    expect(view.page).toBe(1);
    expect(view.pageCount).toBe(2);
    expect(view.previousDisabled).toBe(true);
    expect(view.nextDisabled).toBe(false);
  });

  it('Next turns to the rest and holds itself at the end', () => {
    const turned = run([{ type: 'pageTurned', page: 2 }]);
    const view = cardPage(files(12), turned.pageAsked);
    expect(view.shown.map((file) => file.id)).toEqual(['notes-11', 'notes-12']);
    expect(view.range).toBe('11–12 of 12');
    expect(view.nextDisabled).toBe(true);
    expect(view.previousDisabled).toBe(false);
  });

  it('a detach on the last page stays there with what is left', () => {
    const state = run([
      { type: 'pageTurned', page: 2 },
      { type: 'detachSent', id: 'notes-12' },
    ]);
    const listed = listedFiles(state, files(12));
    const view = cardPage(listed, state.pageAsked);
    expect(view.page).toBe(2);
    expect(view.shown.map((file) => file.id)).toEqual(['notes-11']);
    expect(view.range).toBe('11–11 of 11');
  });

  it('once everything fits on one page the pager goes, and the page held falls back to it', () => {
    const view = cardPage(files(10), 2);
    expect(view.page).toBe(1);
    expect(view.range).toBeNull();
    expect(view.shown).toHaveLength(10);
    expect(cardPage([], 3)).toMatchObject({ page: 1, pageCount: 1, range: null, shown: [] });
  });
});

describe('removing a file', () => {
  it('takes the row off at once, and a second press on it sends nothing', () => {
    const state = run([{ type: 'detachSent', id: 'notes-01' }]);
    expect(listedFiles(state, files(3)).map((file) => file.id)).toEqual(['notes-02', 'notes-03']);
    expect(detachSends(state, 'notes-01')).toBe(false);
    expect(detachSends(state, 'notes-02')).toBe(true);
    expect(run([{ type: 'detachSent', id: 'notes-01' }], state)).toBe(state);
  });

  it('the server agreeing changes nothing on screen; the page then speaks for itself', () => {
    const state = run([
      { type: 'detachSent', id: 'notes-01' },
      { type: 'detachAnswered', id: 'notes-01', error: null },
    ]);
    expect(state.error).toBeNull();
    expect(state.removing).toEqual(['notes-01']);
    expect(run([{ type: 'serverAnswered' }], state).removing).toEqual([]);
  });

  it('a refused remove puts the row back and says why', () => {
    const state = run([
      { type: 'detachSent', id: 'notes-01' },
      { type: 'detachAnswered', id: 'notes-01', error: 'Only owners and editors detach.' },
    ]);
    expect(state.error).toBe('Only owners and editors detach.');
    expect(listedFiles(state, files(2))).toHaveLength(2);
    expect(detachSends(state, 'notes-01')).toBe(true);
  });

  it('a new remove clears the last error', () => {
    const failed = run([
      { type: 'detachSent', id: 'a' },
      { type: 'detachAnswered', id: 'a', error: 'No' },
    ]);
    expect(run([{ type: 'detachSent', id: 'b' }], failed).error).toBeNull();
  });
});

describe('the heading and the counts', () => {
  it('says how many are attached', () => {
    expect(attachedLabel(0)).toBe('none attached');
    expect(attachedLabel(12)).toBe('12 attached');
  });

  it('counts the files kept in context and the ones searched on demand', () => {
    const line = budgetLine([...files(1, 'always'), ...files(2)], { used: 1200, budget: 24_000 });
    expect(line).toMatchObject({
      alwaysCount: 1,
      alwaysFiles: '1 file',
      onDemandCount: 2,
      percent: 5,
      nearlyFull: false,
    });
    expect(budgetLine(files(1), { used: 0, budget: 24_000 }).alwaysFiles).toBe('0 files');
  });

  it('the bar turns amber from nine tenths of the budget and never runs past full', () => {
    expect(budgetLine([], { used: 21_600, budget: 24_000 }).nearlyFull).toBe(true);
    expect(budgetLine([], { used: 50_000, budget: 24_000 }).percent).toBe(100);
    expect(budgetLine([], { used: 10, budget: 0 }).percent).toBe(100);
  });
});

describe('uploading and the rest', () => {
  it('counts down the uploads, naming a file that failed, and the button says how many are left', () => {
    let state = run([{ type: 'uploadStarted', count: 2 }]);
    expect(uploadLabel(state)).toBe('Uploading 2…');
    state = run([{ type: 'fileUploaded', name: 'big.pdf', error: 'Too large' }], state);
    expect(state.error).toBe('big.pdf: Too large');
    state = run([{ type: 'fileUploaded', name: 'ok.md', error: null }], state);
    expect(uploadLabel(state)).toBe('Upload');
    expect(state.error).toBe('big.pdf: Too large');
  });

  it('a mode change holds that row until it is answered, and shows a refusal', () => {
    const sent = run([{ type: 'modeSent', id: 'notes-01' }]);
    expect(sent.busyId).toBe('notes-01');
    const refused = run([{ type: 'modeAnswered', error: 'Over the budget' }], sent);
    expect(refused).toMatchObject({ busyId: null, error: 'Over the budget' });
  });

  it('only someone who can change the card sees a drag land on it', () => {
    expect(run([{ type: 'dragOver', canEdit: false }]).dragging).toBe(false);
    const over = run([{ type: 'dragOver', canEdit: true }]);
    expect(over.dragging).toBe(true);
    expect(run([{ type: 'dragLeft' }], over).dragging).toBe(false);
  });

  it('opens and closes the library picker', () => {
    const open = run([{ type: 'pickerOpened' }]);
    expect(open.picking).toBe(true);
    expect(run([{ type: 'pickerClosed' }], open).picking).toBe(false);
  });
});
