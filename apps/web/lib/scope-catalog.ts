/**
 * The shared shape of a scope catalog: options carry a group id, groups give
 * the UI its section structure. Pure data types — both the admin forms
 * (setting the org ceiling) and the user connect cards (narrowing within it)
 * render catalogs through the same ScopePicker.
 *
 * An option is a capability BUNDLE, not necessarily one scope: granular
 * Atlassian scopes come dozens to a capability (reading an issue alone takes
 * nine), and 84 checkboxes is not a UI. One checkbox = one coherent
 * capability; its `scopes` travel together, and everything downstream
 * (ceilings, grants, enforcement) still speaks individual scope strings.
 */

export interface ScopeGroup {
  id: string;
  label: string;
}

export interface ScopeOption {
  /** Stable checkbox identity — never sent to the provider. */
  id: string;
  /** The OAuth scopes this capability needs; requested together. */
  scopes: string[];
  label: string;
  /** What checking it lets the MCP tools do, in the operator's terms. */
  hint: string;
  group: string;
  /** Off by default: the scope must exist on the provider app before use. */
  defaultChecked: boolean;
}

/** The union of scopes across the checked options. */
export function scopesOfOptions(
  options: readonly ScopeOption[],
  checkedIds: ReadonlySet<string>
): string[] {
  const union = new Set<string>();
  for (const option of options) {
    if (checkedIds.has(option.id)) option.scopes.forEach((scope) => union.add(scope));
  }
  return [...union];
}

/** Whether every scope the option needs is inside the allowed set. */
export function optionWithin(option: ScopeOption, allowed: ReadonlySet<string>): boolean {
  return option.scopes.every((scope) => allowed.has(scope));
}
