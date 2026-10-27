/** Every domain's differential scenarios (../differential/), in one list. */

import type { Scenario } from '../domain';
import type { DataStore } from '../types';
import { coachMarkScenarios } from './coach-marks/scenarios';
import { identityScenarios } from './identities/scenarios';
import { notificationScenarios } from './notifications/scenarios';
import { sessionScenarios } from './sessions/scenarios';
import { settingScenarios } from './settings/scenarios';
import { userPreferenceScenarios } from './user-preferences/scenarios';
import { connectorConfigScenarios } from './connector-configs/scenarios';
import { providerGrantScenarios } from './provider-grants/scenarios';
import { mcpServerScenarios } from './mcp-servers/scenarios';
import { fileShareScenarios } from './file-shares/scenarios';
import { mirthInstanceScenarios } from './mirth-instances/scenarios';
import { adManagerInstanceScenarios } from './admanager-instances/scenarios';
import { emailSanitizerScenarios } from './email-sanitizer/scenarios';
import { mailReviewScenarios } from './mail-review/scenarios';

export const SCENARIOS: Scenario<DataStore>[] = [
  ...sessionScenarios,
  ...identityScenarios,
  ...userPreferenceScenarios,
  ...settingScenarios,
  ...coachMarkScenarios,
  ...notificationScenarios,
  ...connectorConfigScenarios,
  ...providerGrantScenarios,
  ...mcpServerScenarios,
  ...fileShareScenarios,
  ...mirthInstanceScenarios,
  ...adManagerInstanceScenarios,
  ...emailSanitizerScenarios,
  ...mailReviewScenarios,
];
