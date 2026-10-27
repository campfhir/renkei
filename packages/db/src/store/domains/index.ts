/**
 * Every area of the data store, by the key callers reach it under:
 * `getDataStore().<key>`. Adding an area is a folder beside these (see
 * ../domain.ts) and one line here and one in ./scenarios.ts.
 */

import { agentDrafts } from './agent-drafts';
import { agentOptimizations } from './agent-optimizations';
import { agentRuns } from './agent-runs';
import { agentUsage } from './agent-usage';
import { agents } from './agents';
import { coachMarks } from './coach-marks';
import { identities } from './identities';
import { notifications } from './notifications';
import { sessions } from './sessions';
import { settings } from './settings';
import { userPreferences } from './user-preferences';

export const DOMAINS = {
  sessions,
  identities,
  userPreferences,
  settings,
  coachMarks,
  notifications,
  agents,
  agentRuns,
  agentUsage,
  agentOptimizations,
  agentDrafts,
};
