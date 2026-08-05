/**
 * Jira work items MCP tools
 *
 * Tools for managing Jira issues, boards, sprints, and project structure.
 */

import { readTools } from './read';
import { writeTools } from './write';
import { bulkTools } from './bulk';
import { sprintTools } from './sprints';
import { projectTools } from './project';
import { attachmentTools } from './attachments';
import { utilityTools } from './utilities';

export const jiraTools = [
  ...readTools,
  ...writeTools,
  ...bulkTools,
  ...sprintTools,
  ...projectTools,
  ...attachmentTools,
  ...utilityTools,
];
