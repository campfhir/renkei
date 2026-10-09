/**
 * Where a person reviews a Jira admin change request: the page every
 * proposal tool links to, since applying happens there and nowhere else.
 */

import { getPublicBaseUrl } from '@renkei/settings';
import type { MCPToolContext } from '../common';

/**
 * The review page's URL, less the request's id: absolute when the
 * deployment knows its address.
 */
export function reviewPrefix(context: MCPToolContext): string {
  const base = context.origin || getPublicBaseUrl() || '';
  return `${base}/jira-admin/changes/`;
}
