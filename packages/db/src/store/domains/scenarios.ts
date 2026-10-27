/** Every domain's differential scenarios (../differential/), in one list. */

import type { Scenario } from '../domain';
import type { DataStore } from '../types';
import { coachMarkScenarios } from './coach-marks/scenarios';
import { identityScenarios } from './identities/scenarios';
import { notificationScenarios } from './notifications/scenarios';
import { sessionScenarios } from './sessions/scenarios';
import { settingScenarios } from './settings/scenarios';
import { userPreferenceScenarios } from './user-preferences/scenarios';
import { resourceGrantScenarios } from './resource-grants/scenarios';
import { chatScenarios } from './chats/scenarios';
import { chatThreadScenarios } from './chat-threads/scenarios';
import { chatProjectScenarios } from './chat-projects/scenarios';
import { promptLibraryScenarios } from './prompt-libraries/scenarios';
import { userMemoryScenarios } from './user-memory/scenarios';
import { artifactScenarios } from './artifacts/scenarios';
import { codeProjectScenarios } from './code-projects/scenarios';
import { codeTemplateScenarios } from './code-templates/scenarios';
import { chatModelScenarios } from './chat-models/scenarios';

export const SCENARIOS: Scenario<DataStore>[] = [
  ...sessionScenarios,
  ...identityScenarios,
  ...userPreferenceScenarios,
  ...settingScenarios,
  ...coachMarkScenarios,
  ...notificationScenarios,
  ...resourceGrantScenarios,
  ...chatScenarios,
  ...chatThreadScenarios,
  ...chatProjectScenarios,
  ...promptLibraryScenarios,
  ...userMemoryScenarios,
  ...artifactScenarios,
  ...codeProjectScenarios,
  ...codeTemplateScenarios,
  ...chatModelScenarios,
];
