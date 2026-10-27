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

export const SCENARIOS: Scenario<DataStore>[] = [
  ...sessionScenarios,
  ...identityScenarios,
  ...userPreferenceScenarios,
  ...settingScenarios,
  ...coachMarkScenarios,
  ...notificationScenarios,
  ...batchJobScenarios,
  ...batchJobScheduleScenarios,
];
