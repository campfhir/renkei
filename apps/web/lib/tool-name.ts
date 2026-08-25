/**
 * Moved to @renkei/agents so the workers can name tools the same way in
 * their logs — a tool called by an agent should read identically wherever
 * it is reported. Re-exported here because the web app refers to it by this
 * path in a dozen places.
 */

export { friendlyToolName } from '@renkei/agents';
