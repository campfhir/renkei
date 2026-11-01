/**
 * The top-bar search (omni-search.model.ts), as a person using it would
 * describe it. The places are matched by lib/app-index.ts's own
 * matchPlaces, so a setting, connector or organization setting found here
 * is the one the box finds. The browser specs keep what only a browser
 * shows: Ctrl+K reaching the box, a result opening its page scrolled to
 * the element (omni-deep-search.spec.ts), an artifact written by a real
 * chat turn found through the library's search, and the phone's magnifier
 * (omni-search.spec.ts).
 */

// The icon set is drawn with JSX, which these node tests do not compile; the
// places only carry its paths, so each icon stands in as its own name.
jest.mock('@/components/icons', () => ({
  ICONS: new Proxy({}, { get: (_target, name) => `icon:${String(name)}` }),
}));

import { matchPlaces } from '@/lib/app-index';
import type { ChatListItem } from '@/lib/chat/views';
import {
  LIMITS,
  buildSections,
  currentArtifacts,
  currentHits,
  currentIndex,
  enterTarget,
  initialOmni,
  isSearchable,
  omniReducer,
  queryText,
  saidPending,
  showing,
  withFind,
  type OmniAction,
  type OmniArtifact,
  type OmniPage,
  type OmniProject,
  type OmniState,
  type Result,
  type SectionInput,
} from './omni-search.model';

const ICONS = { chat: 'i-chat', pages: 'i-pages', code: 'i-code', artifact: 'i-artifact' };

const PAGES: OmniPage[] = [
  { label: 'Home', href: '/', icon: 'i-home' },
  { label: 'Connectors', href: '/connectors', icon: 'i-plug' },
  { label: 'Preferences', href: '/preferences', icon: 'i-sliders' },
];

function chat(n: number, over: Partial<ChatListItem> = {}): ChatListItem {
  return {
    id: `chat-${n}`,
    title: `Chat ${n}`,
    projectId: null,
    projectName: null,
    projectKind: null,
    projectBranch: null,
    updatedAt: '2026-10-01T09:00:00.000Z',
    lastMessageAt: null,
    archived: false,
    temporary: false,
    ownerSubject: 'me',
    ownerName: null,
    via: 'owner',
    ...over,
  };
}

const project = (over: Partial<OmniProject>): OmniProject => ({
  id: 'p1',
  name: 'Project',
  repoFullName: null,
  ...over,
});

const artifact = (over: Partial<OmniArtifact>): OmniArtifact => ({
  id: 'a1',
  filename: 'file.csv',
  summary: null,
  chat: null,
  ...over,
});

const fold = (actions: OmniAction[], from: OmniState = initialOmni) =>
  actions.reduce(omniReducer, from);

/** The results for what the box holds, as a person with `isOperator` sees them. */
function search(raw: string, over: Partial<SectionInput> = {}, isOperator = false) {
  const query = queryText({ query: raw });
  return buildSections({
    query,
    artifacts: [],
    pages: PAGES,
    projects: [],
    chats: [],
    hits: new Map(),
    places: matchPlaces(query, isOperator),
    icons: ICONS,
    ...over,
  });
}

const titles = (sections: ReturnType<typeof search>) => sections.map((s) => s.title);
const flat = (sections: ReturnType<typeof search>): Result[] => sections.flatMap((s) => s.results);
const section = (sections: ReturnType<typeof search>, title: string) =>
  sections.find((s) => s.title === title)?.results ?? [];

describe('finding', () => {
  it('finds a page in the menu by part of its name, ignoring case and spaces', () => {
    expect(section(search('  PREFER '), 'Pages')).toEqual([
      { href: '/preferences', label: 'Preferences', icon: 'i-sliders' },
    ]);
  });

  it('shows nothing for an empty box', () => {
    expect(search('   ')).toEqual([]);
  });

  it('finds nothing for words nothing holds, and leaves out empty sections', () => {
    expect(search('zzz no such place')).toEqual([]);
  });

  it('finds dark mode under Settings, down to the appearance section', () => {
    const settings = section(search('dark mode'), 'Settings');
    expect(settings.find((r) => /Dark mode and appearance/.test(r.label))?.href).toBe(
      '/preferences#appearance-heading'
    );
  });

  it('finds a connector by a product inside it, and opens it with the words for the catalog', () => {
    const connectors = section(search('sharepoint'), 'Connectors');
    const microsoft = connectors.find((r) => /Microsoft 365/.test(r.label));
    expect(microsoft?.href).toBe('/connectors?find=sharepoint#connector-microsoft');
  });

  it('finds OnBase by its own name', () => {
    const connectors = section(search('onbase'), 'Connectors');
    expect(connectors.find((r) => /OnBase/.test(r.label))?.href).toBe(
      '/connectors?find=onbase#connector-hyland'
    );
  });

  it('sends an operator straight to an organization setting, and offers it to no one else', () => {
    const asOperator = section(search('safety', {}, true), 'Organization');
    const safety = asOperator.find((r) => /Safety/.test(r.label));
    expect(safety?.href).toBe('/admin/settings#settings-safety');
    expect(safety?.detail).toContain('Organization settings');
    expect(section(search('safety', {}, false), 'Organization')).toEqual([]);
  });

  it('adds the words to an address that has no element to scroll to', () => {
    expect(withFind('/connectors', 'jira cloud')).toBe('/connectors?find=jira+cloud');
    expect(withFind('/connectors#connector-x', 'x')).toBe('/connectors?find=x#connector-x');
  });

  it('finds chat projects and code projects by name, each opened where it lives', () => {
    const projects = [
      project({ id: 'p1', name: 'Budget planning', repoFullName: null }),
      project({ id: 'p2', name: 'Budget service', repoFullName: 'acme/budget' }),
    ];
    expect(section(search('budget', { projects }), 'Projects')).toEqual([
      {
        href: '/chat/projects/p1',
        label: 'Budget planning',
        detail: 'Chat project',
        icon: 'i-pages',
      },
      { href: '/code/p2', label: 'Budget service', detail: 'acme/budget', icon: 'i-code' },
    ]);
  });

  it('finds a chat by its title or by its project, with the project under it', () => {
    const chats = [
      chat(1, { title: 'Quarterly report draft' }),
      chat(2, { title: 'Untitled', projectId: 'p', projectKind: 'chat', projectName: 'Reports' }),
      chat(3, { title: 'Lunch' }),
    ];
    expect(section(search('report', { chats }), 'Chats')).toEqual([
      { href: '/chat/chat-1', label: 'Quarterly report draft', detail: undefined, icon: 'i-chat' },
      { href: '/chat/chat-2', label: 'Untitled', detail: 'Reports', icon: 'i-pages' },
    ]);
  });

  it('finds an untitled chat as "New chat"', () => {
    expect(section(search('new chat', { chats: [chat(1, { title: null })] }), 'Chats')[0]).toEqual(
      expect.objectContaining({ label: 'New chat' })
    );
  });

  it('lists chats found by title before those found by what was said, which show the line', () => {
    const chats = [
      chat(1, { title: 'Vendor call' }),
      chat(2, { title: 'Invoice from the vendor' }),
    ];
    const hits = new Map([
      ['chat-1', '…the invoice was late…'],
      ['chat-2', '…invoice…'],
    ]);
    const results = section(search('invoice', { chats, hits }), 'Chats');
    expect(results.map((r) => [r.label, r.detail])).toEqual([
      ['Invoice from the vendor', undefined],
      ['Vendor call', '…the invoice was late…'],
    ]);
  });

  it('shows a code project chat with the code mark', () => {
    const chats = [chat(1, { title: 'Fix the build', projectId: 'p', projectKind: 'code' })];
    expect(section(search('build', { chats }), 'Chats')[0].icon).toBe('i-code');
  });

  it('finds an artifact by what the library matched, with its summary under it', () => {
    const artifacts = [
      artifact({
        id: 'a1',
        filename: 'close-workbook.csv',
        summary: 'Month-end ledger reconciliation',
      }),
      artifact({
        id: 'a2',
        filename: 'notes.txt',
        chat: { id: 'c', title: 'Standup', projectId: null },
      }),
      artifact({ id: 'a3', filename: 'loose.txt' }),
    ];
    expect(section(search('reconciliation', { artifacts }), 'Artifacts')).toEqual([
      {
        href: '/chat/artifacts?artifact=a1',
        label: 'close-workbook.csv',
        detail: 'Month-end ledger reconciliation',
        icon: 'i-artifact',
      },
      {
        href: '/chat/artifacts?artifact=a2',
        label: 'notes.txt',
        detail: 'Standup',
        icon: 'i-artifact',
      },
      {
        href: '/chat/artifacts?artifact=a3',
        label: 'loose.txt',
        detail: 'Artifact',
        icon: 'i-artifact',
      },
    ]);
  });

  it('lists the sections in a fixed order: chats, artifacts, projects, pages, then places', () => {
    const sections = search(
      'connect',
      {
        chats: [chat(1, { title: 'Connect the CRM' })],
        artifacts: [artifact({ filename: 'connect.md' })],
        projects: [project({ name: 'Connectors rollout', repoFullName: null })],
      },
      true
    );
    const order = [
      'Chats',
      'Artifacts',
      'Projects',
      'Pages',
      'Organization',
      'Connectors',
      'Settings',
    ];
    const listed = titles(sections);
    expect(listed.slice(0, 4)).toEqual(order.slice(0, 4));
    expect([...listed].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(listed);
  });

  it('caps each section', () => {
    const many = Array.from({ length: 20 }, (_, i) => i);
    const sections = search('item', {
      chats: many.map((i) => chat(i, { title: `item ${i}` })),
      artifacts: many.map((i) => artifact({ id: `a${i}`, filename: `item-${i}` })),
      projects: many.map((i) => project({ id: `p${i}`, name: `item ${i}`, repoFullName: null })),
      pages: many.map((i) => ({ label: `item ${i}`, href: `/item/${i}`, icon: 'i' })),
    });
    expect(section(sections, 'Chats')).toHaveLength(LIMITS.chats);
    expect(section(sections, 'Artifacts')).toHaveLength(LIMITS.artifacts);
    expect(section(sections, 'Projects')).toHaveLength(LIMITS.projects);
    expect(section(sections, 'Pages')).toHaveLength(LIMITS.pages);
  });
});

describe('the box', () => {
  it('opens its results on focus once something is typed', () => {
    const focused = fold([{ type: 'focus' }]);
    expect(showing(focused)).toBe(false);
    expect(showing(fold([{ type: 'type', value: 'prefer' }], focused))).toBe(true);
  });

  it('does not show results for spaces alone', () => {
    expect(showing(fold([{ type: 'type', value: '   ' }]))).toBe(false);
  });

  it('Escape clears the text first, then closes the results', () => {
    const typed = fold([{ type: 'type', value: 'connectors' }]);
    const once = fold([{ type: 'escape' }], typed);
    expect(once.query).toBe('');
    expect(showing(once)).toBe(false);
  });

  it('on a phone, Escape with the text cleared folds the field back into the magnifier', () => {
    const open = fold([{ type: 'magnifier' }, { type: 'type', value: 'x' }]);
    expect(open.expanded).toBe(true);
    const cleared = fold([{ type: 'escape' }], open);
    expect(cleared.expanded).toBe(true);
    expect(fold([{ type: 'escape' }], cleared).expanded).toBe(false);
  });

  it('the magnifier opens the field', () => {
    const state = fold([{ type: 'magnifier' }]);
    expect(state.expanded && state.open).toBe(true);
  });

  it('choosing a result or going to another page empties, closes and folds it', () => {
    const open = fold([{ type: 'magnifier' }, { type: 'type', value: 'prefer' }]);
    for (const type of ['close', 'navigated'] as const) {
      expect(fold([{ type }], open)).toEqual(
        expect.objectContaining({ query: '', open: false, expanded: false })
      );
    }
  });

  it('a click outside closes the results but keeps the text', () => {
    const state = fold([{ type: 'type', value: 'prefer' }, { type: 'dismiss' }]);
    expect(showing(state)).toBe(false);
    expect(state.query).toBe('prefer');
  });

  it('keeps the whole history once it arrives', () => {
    expect(fold([{ type: 'all-chats', chats: [chat(1)] }]).allChats).toEqual([chat(1)]);
  });
});

describe('picking with the keyboard', () => {
  const results = flat(search('e', { pages: PAGES }));

  it('starts on the first result', () => {
    expect(enterTarget(fold([{ type: 'type', value: 'e' }]), results)).toBe(results[0].href);
  });

  it('the arrows walk the results and wrap around', () => {
    const count = results.length;
    const up = fold([{ type: 'move', delta: -1, count }]);
    expect(currentIndex(up, count)).toBe(count - 1);
    expect(currentIndex(fold([{ type: 'move', delta: 1, count }], up), count)).toBe(0);
  });

  it('typing again goes back to the first result', () => {
    const state = fold([
      { type: 'move', delta: 1, count: 3 },
      { type: 'type', value: 'pr' },
    ]);
    expect(state.active).toBe(0);
  });

  it('pointing at a result picks it for Enter', () => {
    expect(enterTarget(fold([{ type: 'hover', index: 2 }]), results)).toBe(results[2].href);
  });

  it('the pick stays inside a list that shrank as more was typed', () => {
    const state = fold([{ type: 'hover', index: 5 }]);
    expect(currentIndex(state, 2)).toBe(1);
  });

  it('with nothing found, the arrows do not break it and Enter opens nothing', () => {
    const state = fold([
      { type: 'type', value: 'zzz' },
      { type: 'move', delta: 1, count: 0 },
      { type: 'move', delta: -1, count: 0 },
    ]);
    expect(state.active).toBe(0);
    expect(enterTarget(state, [])).toBeNull();
  });

  it('Enter on a setting opens its page at the element that holds it', () => {
    const settings = flat(search('dark mode'));
    const index = settings.findIndex((r) => /Dark mode and appearance/.test(r.label));
    expect(enterTarget(fold([{ type: 'hover', index }]), settings)).toBe(
      '/preferences#appearance-heading'
    );
  });
});

describe('what the server says', () => {
  it('asks once two characters are typed', () => {
    expect(isSearchable('a')).toBe(false);
    expect(isSearchable('ab')).toBe(true);
  });

  it('says "Searching…" until what was said comes back for this text', () => {
    const typed = fold([{ type: 'type', value: 'invoice' }]);
    expect(saidPending(typed)).toBe(true);
    const answered = fold([{ type: 'said', query: 'invoice', hits: [] }], typed);
    expect(saidPending(answered)).toBe(false);
    expect(saidPending(fold([{ type: 'type', value: 'i' }]))).toBe(false);
  });

  it('matches the answer to the text as normalized, whatever the case and spacing typed', () => {
    const state = fold([
      { type: 'type', value: '  Late   INVOICE ' },
      { type: 'said', query: 'late invoice', hits: [{ chatId: 'c1', snippet: '…late invoice…' }] },
    ]);
    expect(currentHits(state).get('c1')).toBe('…late invoice…');
  });

  it('never shows an answer for older text under a newer query', () => {
    const state = fold([
      { type: 'type', value: 'invoice' },
      { type: 'said', query: 'invoic', hits: [{ chatId: 'c1', snippet: 'old' }] },
      { type: 'found', query: 'invoic', items: [artifact({})] },
    ]);
    expect(currentHits(state).size).toBe(0);
    expect(currentArtifacts(state)).toEqual([]);
    expect(saidPending(state)).toBe(true);
  });

  it('shows the artifacts found for the text in the box', () => {
    const items = [artifact({ filename: 'ledger.csv' })];
    const state = fold([
      { type: 'type', value: 'ledger' },
      { type: 'found', query: 'ledger', items },
    ]);
    expect(currentArtifacts(state)).toEqual(items);
  });
});
