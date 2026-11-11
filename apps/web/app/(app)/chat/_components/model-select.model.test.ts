/**
 * The composer's model picker (model-select.model.ts), as a person using
 * it would describe it. The browser spec (model-select.spec.ts) keeps only
 * that the menu fits a phone, scrolls inside itself and a searched pick
 * reaches the server.
 */

import {
  closedModelSelect,
  enterPicks,
  matchingModels,
  MENU_MARGIN,
  MENU_MAX_HEIGHT,
  MENU_MIN_HEIGHT,
  MENU_WIDTH,
  modelSelectReducer,
  placeMenu,
  SEARCH_FROM,
  showsSearch,
  type ModelSelectAction,
  type ModelSelectState,
} from './model-select.model';

const model = (id: string, label: string, provider: string, name: string) => ({
  id,
  label,
  provider,
  model: name,
});

const roster = [
  model('haiku', 'Claude Haiku 5.5', 'anthropic', 'claude-haiku-5-5'),
  model('fable', 'Claude Fable 5.2', 'anthropic', 'claude-fable-5-2'),
  model('opus', 'Claude Opus 5.5', 'anthropic', 'claude-opus-5-5'),
  model('luna', 'gpt-5.6 Luna', 'openai', 'gpt-5.6-luna'),
  model('sol', 'gpt-6.1 Sol', 'openai', 'gpt-6.1-sol-1'),
];

const run = (actions: ModelSelectAction[], from: ModelSelectState = closedModelSelect) =>
  actions.reduce(modelSelectReducer, from);

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

describe('search', () => {
  it('is offered once the roster is too long to read at a glance', () => {
    expect(showsSearch(roster.slice(0, SEARCH_FROM - 1))).toBe(false);
    expect(showsSearch([...roster, ...roster].slice(0, SEARCH_FROM))).toBe(true);
  });

  it('keeps the whole roster, in order, until something is typed', () => {
    expect(ids(matchingModels(roster, ''))).toEqual(['haiku', 'fable', 'opus', 'luna', 'sol']);
    expect(ids(matchingModels(roster, '   '))).toEqual(['haiku', 'fable', 'opus', 'luna', 'sol']);
  });

  it('finds a model by its name, its provider or its id, in any case', () => {
    expect(ids(matchingModels(roster, 'OPUS'))).toEqual(['opus']);
    expect(ids(matchingModels(roster, 'openai'))).toEqual(['luna', 'sol']);
    expect(ids(matchingModels(roster, 'sol-1'))).toEqual(['sol']);
  });

  it('needs every word typed, wherever each one is', () => {
    expect(ids(matchingModels(roster, 'claude 5.5'))).toEqual(['haiku', 'opus']);
    expect(ids(matchingModels(roster, 'anthropic luna'))).toEqual([]);
  });
});

describe('the menu', () => {
  it('opens on the whole roster every time, whatever was searched before', () => {
    const searched = run([
      { type: 'toggled' },
      { type: 'searched', query: 'gpt', models: roster },
      { type: 'toggled' },
      { type: 'toggled' },
    ]);
    expect(searched).toEqual({ open: true, query: '', activeId: null });
  });

  it('closes on a pick, unless the model has a thinking switch to set next', () => {
    const open = run([{ type: 'toggled' }]);
    expect(run([{ type: 'picked', supportsThinking: false }], open).open).toBe(false);
    expect(run([{ type: 'picked', supportsThinking: true }], open).open).toBe(true);
  });

  it('closes when dismissed', () => {
    expect(run([{ type: 'toggled' }, { type: 'dismissed' }])).toEqual(closedModelSelect);
  });
});

describe('the keyboard', () => {
  const open = run([{ type: 'toggled' }]);

  it('Enter picks nothing until a search or an arrow key lands on a model', () => {
    expect(enterPicks(open, roster)).toBeNull();
  });

  it('typing puts Enter on the first match; clearing the search takes it off', () => {
    const typed = run([{ type: 'searched', query: 'gpt', models: roster }], open);
    expect(enterPicks(typed, roster)?.id).toBe('luna');
    const cleared = run([{ type: 'searched', query: '', models: roster }], typed);
    expect(enterPicks(cleared, roster)).toBeNull();
  });

  it('a search that matches nothing leaves Enter with nothing to pick', () => {
    const typed = run([{ type: 'searched', query: 'gemini', models: roster }], open);
    expect(enterPicks(typed, roster)).toBeNull();
  });

  it('arrows walk the matches and stop at either end', () => {
    const typed = run([{ type: 'searched', query: 'claude', models: roster }], open);
    const down = { type: 'moved', by: 1, models: roster } as const;
    const up = { type: 'moved', by: -1, models: roster } as const;
    expect(run([down], typed).activeId).toBe('fable');
    expect(run([down, down, down, down], typed).activeId).toBe('opus');
    expect(run([up, up], typed).activeId).toBe('haiku');
  });

  it('the first arrow starts at the top going down and at the bottom going up', () => {
    expect(run([{ type: 'moved', by: 1, models: roster }], open).activeId).toBe('haiku');
    expect(run([{ type: 'moved', by: -1, models: roster }], open).activeId).toBe('sol');
  });
});

describe('placement', () => {
  const desktop = { buttonLeft: 400, buttonTop: 800, viewportWidth: 1280, contentTop: 56 };

  it('opens from the button at full size when there is room', () => {
    expect(placeMenu(desktop)).toEqual({ width: MENU_WIDTH, left: 0, maxHeight: MENU_MAX_HEIGHT });
  });

  it('is pulled left on a phone, so it ends inside the right edge', () => {
    const placed = placeMenu({ ...desktop, buttonLeft: 155, viewportWidth: 390 });
    expect(placed.width).toBe(MENU_WIDTH);
    expect(155 + placed.left + placed.width).toBe(390 - MENU_MARGIN);
  });

  it('is never wider than the screen, and never starts off its left edge', () => {
    const placed = placeMenu({ ...desktop, buttonLeft: 120, viewportWidth: 280 });
    expect(placed.width).toBe(280 - 2 * MENU_MARGIN);
    expect(120 + placed.left).toBe(MENU_MARGIN);
  });

  it('is only as tall as the room under the top bar, and scrolls inside that', () => {
    const placed = placeMenu({ ...desktop, buttonTop: 400 });
    expect(placed.maxHeight).toBe(400 - 56 - 2 * MENU_MARGIN);
  });

  it('keeps a usable height when the button is near the top', () => {
    expect(placeMenu({ ...desktop, buttonTop: 100 }).maxHeight).toBe(MENU_MIN_HEIGHT);
  });
});
