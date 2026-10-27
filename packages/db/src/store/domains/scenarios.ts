/** Every domain's differential scenarios (../differential/), in one list. */

import type { Scenario } from '../domain';
import type { DataStore } from '../types';
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
import { actionableItemScenarios } from './actionable-items/scenarios';
import { firstRunScenarios } from './first-run/scenarios';
import { oauthConsentScenarios } from './oauth-consents/scenarios';
import { deviceKeyRequestScenarios } from './device-key-requests/scenarios';
import { personalAccountScenarios } from './personal-account/scenarios';
import { activityLogScenarios } from './activity-logs/scenarios';
import { toolUsageScenarios } from './tool-usage/scenarios';
import { usageLedgerScenarios } from './usage-ledgers/scenarios';
import { knowledgeChunkScenarios } from './knowledge-chunks/scenarios';

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
  ...actionableItemScenarios,
  ...firstRunScenarios,
  ...oauthConsentScenarios,
  ...deviceKeyRequestScenarios,
  ...personalAccountScenarios,
  ...activityLogScenarios,
  ...toolUsageScenarios,
  ...usageLedgerScenarios,
  ...knowledgeChunkScenarios,
];
