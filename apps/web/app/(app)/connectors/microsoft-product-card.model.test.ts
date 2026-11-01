import { MICROSOFT_PRODUCTS, optionsOfProduct } from '@/lib/microsoft-products';
import { productPanel, selectionPending } from './microsoft-product-card.model';

function product(id: string) {
  const found = MICROSOFT_PRODUCTS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(id);
  return optionsOfProduct(found);
}

const teams = product('teams');
const onenote = product('onenote');
const scopesOf = (options: typeof teams) => [
  ...new Set(options.flatMap((option) => option.scopes)),
];
const idsOf = (options: typeof teams) => new Set(options.map((option) => option.id));
const CEILING = scopesOf([...teams, ...onenote]);

describe('a product panel on the Microsoft 365 card', () => {
  it('before connecting, offers the product’s own capabilities: Teams 5 of 5, OneNote 4 of 4', () => {
    const teamsPanel = productPanel({
      options: teams,
      ceiling: CEILING,
      authorized: null,
      checked: idsOf([...teams, ...onenote]),
      connected: false,
    });
    expect(teamsPanel?.pickerSummary).toBe('What Renkei may do here (5 of 5)');
    expect(teamsPanel?.badge).toBeNull();
    expect(teamsPanel?.pending).toBe(false);
    expect(
      productPanel({
        options: onenote,
        ceiling: CEILING,
        authorized: null,
        checked: idsOf(onenote),
        connected: false,
      })?.pickerSummary
    ).toBe('What Renkei may do here (4 of 4)');
  });

  it('counts only what is ticked, out of what the org allows', () => {
    const partial = productPanel({
      options: teams,
      ceiling: CEILING,
      authorized: null,
      checked: new Set(['Chat.Read']),
      connected: false,
    });
    expect(partial?.pickerSummary).toBe('What Renkei may do here (1 of 5)');
  });

  it('a capability outside the org’s ceiling is not offered', () => {
    const ceiling = CEILING.filter((scope) => !scope.startsWith('Presence'));
    const panel = productPanel({
      options: teams,
      ceiling,
      authorized: null,
      checked: idsOf(teams),
      connected: false,
    });
    expect(panel?.pickable.map((option) => option.id)).not.toContain('Presence.Read.All');
    expect(panel?.pickerSummary).toBe('What Renkei may do here (4 of 4)');
  });

  it('a product the org withheld entirely shows no panel at all', () => {
    expect(
      productPanel({
        options: teams,
        ceiling: scopesOf(onenote),
        authorized: null,
        checked: new Set(),
        connected: false,
      })
    ).toBeNull();
  });

  it('once connected, says how much is granted: "5 of 5 on", or "Off" when nothing is', () => {
    const granted = productPanel({
      options: teams,
      ceiling: CEILING,
      authorized: scopesOf(teams),
      checked: idsOf(teams),
      connected: true,
    });
    expect(granted?.badge).toEqual({ kind: 'on', text: '5 of 5 on' });
    expect(granted?.pending).toBe(false);
    const none = productPanel({
      options: onenote,
      ceiling: CEILING,
      authorized: scopesOf(teams),
      checked: new Set(),
      connected: true,
    });
    expect(none?.badge).toEqual({ kind: 'off', text: 'Off' });
  });

  it('an unticked capability is "Not approved yet" until ticked back', () => {
    const withoutPresence = idsOf(teams.filter((option) => option.id !== 'Presence.Read.All'));
    const input = {
      options: teams,
      ceiling: CEILING,
      authorized: scopesOf(teams),
      connected: true,
    };
    expect(productPanel({ ...input, checked: withoutPresence })?.pending).toBe(true);
    expect(productPanel({ ...input, checked: idsOf(teams) })?.pending).toBe(false);
  });

  it('a newly ticked capability is a draft too', () => {
    const held = scopesOf(teams.filter((option) => option.id !== 'Presence.Read.All'));
    expect(selectionPending(teams, held, idsOf(teams), true)).toBe(true);
  });

  it('claims no change on a grant from before scopes were recorded, or before connecting', () => {
    expect(selectionPending(teams, null, new Set(), true)).toBe(false);
    expect(selectionPending(teams, [], idsOf(teams), false)).toBe(false);
  });
});
