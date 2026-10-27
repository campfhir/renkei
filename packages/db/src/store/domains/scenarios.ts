/** Every domain's differential scenarios (../differential/), in one list. */

import type { Scenario } from '../domain';
import type { DataStore } from '../types';
import { batchJobScheduleScenarios } from './batch-job-schedules/scenarios';
import { batchJobScenarios } from './batch-jobs/scenarios';
import { coachMarkScenarios } from './coach-marks/scenarios';
import { identityScenarios } from './identities/scenarios';
import { notificationScenarios } from './notifications/scenarios';
import { sessionScenarios } from './sessions/scenarios';
import { settingScenarios } from './settings/scenarios';
import { userPreferenceScenarios } from './user-preferences/scenarios';
import { salesforceChangeScenarios } from './salesforce-changes/scenarios';
import { jiraChangeScenarios } from './jira-changes/scenarios';
import { jiraSpaceTemplateScenarios } from './jira-space-templates/scenarios';
import { adminChangeQueueScenarios } from './admin-change-queue/scenarios';
import { salesforceGrantScenarios } from './salesforce-grants/scenarios';

export const SCENARIOS: Scenario<DataStore>[] = [
  ...sessionScenarios,
  ...identityScenarios,
  ...userPreferenceScenarios,
  ...settingScenarios,
  ...coachMarkScenarios,
  ...notificationScenarios,
  ...salesforceChangeScenarios,
  ...jiraChangeScenarios,
  ...jiraSpaceTemplateScenarios,
  ...adminChangeQueueScenarios,
  ...salesforceGrantScenarios,
  ...batchJobScenarios,
  ...batchJobScheduleScenarios,
];
