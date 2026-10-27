/** Every domain's differential scenarios (../differential/), in one list. */

import type { Scenario } from '../domain';
import type { DataStore } from '../types';
import { agentDraftScenarios } from './agent-drafts/scenarios';
import { agentOptimizationScenarios } from './agent-optimizations/scenarios';
import { agentRunScenarios } from './agent-runs/scenarios';
import { agentUsageScenarios } from './agent-usage/scenarios';
import { agentScenarios } from './agents/scenarios';
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
  ...agentScenarios,
  ...agentRunScenarios,
  ...agentUsageScenarios,
  ...agentOptimizationScenarios,
  ...agentDraftScenarios,
];
