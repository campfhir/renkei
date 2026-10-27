/** Every domain's differential scenarios (../differential/), in one list. */

import type { Scenario } from '../domain';
import type { DataStore } from '../types';
import { auditEventScenarios } from './audit-events/scenarios';
import { coachMarkScenarios } from './coach-marks/scenarios';
import { eventLogScenarios } from './event-log/scenarios';
import { identityScenarios } from './identities/scenarios';
import { llmModelScenarios } from './llm-models/scenarios';
import { notificationScenarios } from './notifications/scenarios';
import { oidcConfigScenarios } from './oidc-config/scenarios';
import { orgAccessScenarios } from './org-access/scenarios';
import { scheduleCalendarScenarios } from './schedule-calendars/scenarios';
import { sessionScenarios } from './sessions/scenarios';
import { settingScenarios } from './settings/scenarios';
import { usageScenarios } from './usage/scenarios';
import { userPreferenceScenarios } from './user-preferences/scenarios';

export const SCENARIOS: Scenario<DataStore>[] = [
  ...sessionScenarios,
  ...identityScenarios,
  ...userPreferenceScenarios,
  ...settingScenarios,
  ...coachMarkScenarios,
  ...notificationScenarios,
  ...auditEventScenarios,
  ...eventLogScenarios,
  ...oidcConfigScenarios,
  ...llmModelScenarios,
  ...scheduleCalendarScenarios,
  ...orgAccessScenarios,
  ...usageScenarios,
];
