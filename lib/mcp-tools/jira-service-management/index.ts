/**
 * Jira Service Management (JSM) MCP tools
 *
 * Tools for managing customer requests, service desks, and support operations.
 */

import { jsmTools } from './jsm';
import { requestDetailsTools } from './request-details';
import { customerTools } from './customers';

export const jiraServiceManagementTools = [
  ...jsmTools,
  ...requestDetailsTools,
  ...customerTools,
];
