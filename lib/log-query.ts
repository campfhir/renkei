import { FilterExpr, parseLogQueryExpr as boredLogsParseLogQueryExpr } from '@campfhir/bored-logs';

/**
 * Build a FilterExpr with enforced tenant and user context.
 * Removes any existing tenantId, accountId, or userId from user query,
 * then appends enforced && tenantId && accountId filters.
 */
export function buildEnforcedLogQuery(
  userQuery: string | null,
  tenantId: string,
  accountId?: string
): FilterExpr | null {
  // Parse user query into tree
  let userTree = userQuery ? parseLogQueryExpr(userQuery) : null;

  // Remove any existing tenantId, accountId, or userId nodes from the tree
  if (userTree) {
    userTree = removeRestrictedFields(userTree, ['tenantId', 'accountId', 'userId']);
  }

  // Build enforced filter nodes (wrapped in OR nodes for consistency with parser output)
  const enforcedNodes: FilterExpr[] = [];
  enforcedNodes.push({
    type: 'or',
    nodes: [{
      type: 'filter',
      filter: { key: 'tenantId', operator: 'contains', value: tenantId },
    } as FilterExpr],
  } as FilterExpr);
  if (accountId) {
    enforcedNodes.push({
      type: 'or',
      nodes: [{
        type: 'filter',
        filter: { key: 'accountId', operator: 'contains', value: accountId },
      } as FilterExpr],
    } as FilterExpr);
  }

  // Combine: (user query) && tenantId && accountId
  let result = userTree;
  for (const node of enforcedNodes) {
    if (!result) {
      result = node;
    } else {
      // Create an AND node with all nodes
      const existingNodes = (result as any).type === 'and'
        ? (result as any).nodes
        : [result];
      result = {
        type: 'and',
        nodes: [...existingNodes, node],
      } as FilterExpr;
    }
  }

  return result;
}

/**
 * Remove restricted fields from a FilterExpr tree.
 * Recursively removes filter nodes with restricted keys and collapses the tree.
 */
function removeRestrictedFields(tree: FilterExpr, restrictedKeys: string[]): FilterExpr | null {
  const tree_ = tree as any;

  // Handle filter leaf nodes
  if (tree_.type === 'filter') {
    const filter = tree_.filter;
    // Remove if key is restricted
    return restrictedKeys.includes(filter.key) ? null : tree;
  }

  // Handle AND/OR nodes
  if (tree_.type === 'and' || tree_.type === 'or') {
    // Filter and remove null entries
    const filteredNodes = (tree_.nodes as FilterExpr[])
      .map(node => removeRestrictedFields(node, restrictedKeys))
      .filter((node): node is FilterExpr => node !== null);

    // If no nodes left, return null
    if (filteredNodes.length === 0) return null;

    // If only one node left, return it (collapse the operation)
    if (filteredNodes.length === 1) return filteredNodes[0];

    // Multiple nodes, keep the operation
    return { type: tree_.type, nodes: filteredNodes } as FilterExpr;
  }

  return tree;
}

/**
 * Parse a query string to a FilterExpr tree.
 * Handles || / && operators and parenthesized grouping.
 *
 * Example:
 *   "level:error && tenantId:abc123"
 *   "(level:error || level:warn) && tenantId:abc123"
 *
 * Uses the parser from @campfhir/bored-logs.
 */
export function parseLogQueryExpr(query: string): FilterExpr | null {
  if (!query || !query.trim()) {
    return null;
  }

  const result = boredLogsParseLogQueryExpr(query);
  if (!result.ok) {
    // Return null on parse error instead of throwing
    return null;
  }
  return result.val;
}

/**
 * Build query options for bored-logs adapter.query()
 * Includes enforced context filters.
 */
export function buildLogQueryOptions(
  userQuery: string | null,
  tenantId: string,
  accountId?: string
): Record<string, any> {
  const filterExpr = buildEnforcedLogQuery(userQuery, tenantId, accountId);

  return {
    filter: filterExpr,
    limit: 1000, // Reasonable default
  };
}
