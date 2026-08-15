/**
 * The product split must stay a partition of the scope catalog.
 *
 * Microsoft is one grant rendered as four cards, and each card draws its
 * checkboxes from the scope groups assigned to it. Nothing at runtime
 * notices a group that belongs to no card: the option stays in the ceiling,
 * stays in DEFAULT_MICROSOFT_SCOPES, and stays in the authorize URL if it
 * happens to be selected — it simply never appears for anyone to select. The
 * failure is a capability that quietly cannot be granted, with no error and
 * nothing missing from any list an operator would think to check.
 *
 * The reverse — a group named by a card but absent from the catalog — is
 * just as quiet: that card renders one fewer heading than intended.
 */

import { MICROSOFT_SCOPE_GROUPS, MICROSOFT_SCOPE_OPTIONS } from './microsoft-scopes';
import { MICROSOFT_PRODUCTS, groupsOfProduct, optionsOfProduct } from './microsoft-products';

const assigned = MICROSOFT_PRODUCTS.flatMap((product) => product.groupIds);

describe('Microsoft product cards', () => {
  it('covers every scope group in the catalog', () => {
    const catalog = MICROSOFT_SCOPE_GROUPS.map((group) => group.id);
    expect([...assigned].sort()).toEqual([...catalog].sort());
  });

  it('assigns each group to exactly one product', () => {
    // Two cards claiming a group would render the same checkbox twice, and
    // the copies would disagree the moment one card filtered differently.
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it('leaves no capability unreachable', () => {
    // The property that actually matters to a user: every option in the
    // catalog is offered on some card.
    const reachable = new Set(
      MICROSOFT_PRODUCTS.flatMap((product) => optionsOfProduct(product)).map((option) => option.id)
    );
    const missing = MICROSOFT_SCOPE_OPTIONS.filter((option) => !reachable.has(option.id));
    expect(missing.map((option) => option.id)).toEqual([]);
  });

  it('gives every product a distinct id', () => {
    // Ids key the extras map and the React list; a duplicate would drop one
    // card's controls onto another.
    const ids = MICROSOFT_PRODUCTS.map((product) => product.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('puts SharePoint and OneDrive on separate cards', () => {
    // They share one implementation (graph/documents.ts registers both) and
    // one grant, which is exactly why the split is easy to undo by accident.
    // A shared library and someone's personal files are different decisions.
    const sharepoint = MICROSOFT_PRODUCTS.find((product) => product.id === 'sharepoint');
    const onedrive = MICROSOFT_PRODUCTS.find((product) => product.id === 'onedrive');

    expect(groupsOfProduct(sharepoint!).map((group) => group.id)).toEqual(['sharepoint']);
    expect(groupsOfProduct(onedrive!).map((group) => group.id)).toEqual(['files']);
  });
});
