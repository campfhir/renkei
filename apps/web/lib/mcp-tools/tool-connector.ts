/**
 * Moved to `@renkei/tool-outcomes` alongside the outcome catalog — the
 * worker needs to attribute a tool to a connector too, and it cannot import
 * from `apps/web`. New code should import from the package directly.
 */

export { connectorKeyForTool } from '@renkei/tool-outcomes';
