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
 * on every write scope, which can only hide it, never under-gate it.
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

    case 'fabric_create_workspace_preview':
    case 'fabric_create_workspace_confirm':
    case 'fabric_update_workspace_preview':
    case 'fabric_update_workspace_confirm':
      return ['Workspace.Read.All', 'Workspace.ReadWrite.All'];

    case 'fabric_get_notebook_definition':
    case 'fabric_create_notebook_preview':
    case 'fabric_create_notebook_confirm':
    case 'fabric_update_notebook_preview':
    case 'fabric_update_notebook_confirm':
      return ['Workspace.Read.All', 'Notebook.ReadWrite.All'];

    case 'fabric_get_pipeline_definition':
    case 'fabric_create_pipeline_preview':
    case 'fabric_create_pipeline_confirm':
    case 'fabric_update_pipeline_preview':
    case 'fabric_update_pipeline_confirm':
      return ['Workspace.Read.All', 'DataPipeline.ReadWrite.All'];

    default:
      return ['Workspace.ReadWrite.All', 'Notebook.ReadWrite.All', 'DataPipeline.ReadWrite.All'];
  }
}
