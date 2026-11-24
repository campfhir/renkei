/**
 * Which delegated Fabric scope each fabric_ tool stands on, by the short
 * names a Fabric token carries (lib/fabric-scopes.ts shortens the
 * requested ones to match). withScopeGate filters at REGISTRATION with AND
 * semantics, so a tool whose scopes the grant lacks never appears.
 *
 * Fabric wants read-AND-write on a notebook or pipeline even to read its
 * definition, so the definition reads stand on the ReadWrite scopes.
 *
 * The `default:` branch is load-bearing: a new tool nobody mapped stands
 * on both definition scopes, which can only hide it, never under-gate it.
 */
export function fabricScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'fabric_check_access':
      return [];

    case 'fabric_list_workspaces':
    case 'fabric_get_workspace':
    case 'fabric_list_items':
    case 'fabric_get_operation':
      return ['Workspace.Read.All'];

    case 'fabric_list_tables':
      return ['Workspace.Read.All', 'Lakehouse.Read.All'];

    case 'fabric_list_capacities':
      return ['Capacity.Read.All'];

    // Pull requests on a code project: nothing reaches Fabric until merged,
    // so they stand on the workspace read the references resolve with; the
    // code host's own grant is what the commit and pull request use.
    case 'fabric_propose_items_preview':
    case 'fabric_propose_items_confirm':
    case 'fabric_setup_pipeline_preview':
    case 'fabric_setup_pipeline_confirm':
      return ['Workspace.Read.All'];

    case 'fabric_get_notebook_definition':
      return ['Workspace.Read.All', 'Notebook.ReadWrite.All'];
    case 'fabric_get_pipeline_definition':
      return ['Workspace.Read.All', 'DataPipeline.ReadWrite.All'];

    // Reads definitions as fabric_get_*_definition do; each item's own
    // scope is checked against the grant in the preview.
    case 'fabric_export_items_preview':
    case 'fabric_export_items_confirm':
      return ['Workspace.Read.All'];

    default:
      return ['Notebook.ReadWrite.All', 'DataPipeline.ReadWrite.All'];
  }
}
