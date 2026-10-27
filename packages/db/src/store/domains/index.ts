/**
 * Every area of the data store, by the key callers reach it under:
 * `getDataStore().<key>`. Adding an area is a folder beside these (see
 * ../domain.ts) and one line here and one in ./scenarios.ts.
 */

import { coachMarks } from './coach-marks';
import { identities } from './identities';
import { notifications } from './notifications';
import { sessions } from './sessions';
import { settings } from './settings';
import { userPreferences } from './user-preferences';
import { connectorConfigs } from './connector-configs';
import { providerGrants } from './provider-grants';
import { mcpServers } from './mcp-servers';
import { fileShares } from './file-shares';
import { mirthInstances } from './mirth-instances';
import { adManagerInstances } from './admanager-instances';
import { emailSanitizer } from './email-sanitizer';
import { mailReview } from './mail-review';

export const DOMAINS = {
  sessions,
  identities,
  userPreferences,
  settings,
  coachMarks,
  notifications,
  connectorConfigs,
  providerGrants,
  mcpServers,
  fileShares,
  mirthInstances,
  adManagerInstances,
  emailSanitizer,
  mailReview,
};
