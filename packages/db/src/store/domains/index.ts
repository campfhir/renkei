/**
 * Every area of the data store, by the key callers reach it under:
 * `getDataStore().<key>`. Adding an area is a folder beside these (see
 * ../domain.ts) and one line here and one in ./scenarios.ts.
 */

import { auditEvents } from './audit-events';
import { coachMarks } from './coach-marks';
import { eventLog } from './event-log';
import { identities } from './identities';
import { llmModels } from './llm-models';
import { notifications } from './notifications';
import { oidcConfig } from './oidc-config';
import { orgAccess } from './org-access';
import { scheduleCalendars } from './schedule-calendars';
import { sessions } from './sessions';
import { settings } from './settings';
import { usage } from './usage';
import { userPreferences } from './user-preferences';

export const DOMAINS = {
  sessions,
  identities,
  userPreferences,
  settings,
  coachMarks,
  notifications,
  auditEvents,
  eventLog,
  oidcConfig,
  llmModels,
  scheduleCalendars,
  orgAccess,
  usage,
};
