/**
 * Every area of the data store, by the key callers reach it under:
 * `getDataStore().<key>`. Adding an area is a folder beside these (see
 * ../domain.ts) and one line here and one in ./scenarios.ts.
 */

import { batchJobSchedules } from './batch-job-schedules';
import { batchJobs } from './batch-jobs';
import { coachMarks } from './coach-marks';
import { identities } from './identities';
import { notifications } from './notifications';
import { sessions } from './sessions';
import { settings } from './settings';
import { userPreferences } from './user-preferences';
import { salesforceChanges } from './salesforce-changes';
import { jiraChanges } from './jira-changes';
import { jiraSpaceTemplates } from './jira-space-templates';
import { adminChangeQueue } from './admin-change-queue';
import { salesforceGrants } from './salesforce-grants';

export const DOMAINS = {
  sessions,
  identities,
  userPreferences,
  settings,
  coachMarks,
  notifications,
  salesforceChanges,
  jiraChanges,
  jiraSpaceTemplates,
  adminChangeQueue,
  salesforceGrants,
  batchJobs,
  batchJobSchedules,
};
