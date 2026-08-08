/**
 * The shared shape of a scope catalog: options carry a group id, groups give
 * the UI its section structure. Pure data types — both the admin forms
 * (setting the org ceiling) and the user connect cards (narrowing within it)
 * render catalogs through the same ScopePicker.
 */

export interface ScopeGroup {
  id: string;
  label: string;
}

export interface ScopeOption {
  scope: string;
  label: string;
  /** What checking it lets the MCP tools do, in the operator's terms. */
  hint: string;
  group: string;
  /** Off by default: the scope must exist on the provider app before use. */
  defaultChecked: boolean;
}
