/** Every domain's differential scenarios (../differential/), in one list. */

import type { Scenario } from '../domain';
import type { DataStore } from '../types';
import { batchJobScheduleScenarios } from './batch-job-schedules/scenarios';
import { batchJobScenarios } from './batch-jobs/scenarios';
import { auditEventScenarios } from './audit-events/scenarios';
import { agentDraftScenarios } from './agent-drafts/scenarios';
import { agentOptimizationScenarios } from './agent-optimizations/scenarios';
import { agentRunScenarios } from './agent-runs/scenarios';
import { agentUsageScenarios } from './agent-usage/scenarios';
import { agentScenarios } from './agents/scenarios';
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
import { salesforceChangeScenarios } from './salesforce-changes/scenarios';
import { jiraChangeScenarios } from './jira-changes/scenarios';
import { jiraSpaceTemplateScenarios } from './jira-space-templates/scenarios';
import { adminChangeQueueScenarios } from './admin-change-queue/scenarios';
import { salesforceGrantScenarios } from './salesforce-grants/scenarios';
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
  ...salesforceChangeScenarios,
  ...jiraChangeScenarios,
  ...jiraSpaceTemplateScenarios,
  ...adminChangeQueueScenarios,
  ...salesforceGrantScenarios,
  ...batchJobScenarios,
  ...batchJobScheduleScenarios,
  ...auditEventScenarios,
  ...eventLogScenarios,
  ...oidcConfigScenarios,
  ...llmModelScenarios,
  ...scheduleCalendarScenarios,
  ...orgAccessScenarios,
  ...usageScenarios,
  ...agentScenarios,
  ...agentRunScenarios,
  ...agentUsageScenarios,
  ...agentOptimizationScenarios,
  ...agentDraftScenarios,
  ...connectorConfigScenarios,
  ...providerGrantScenarios,
  ...mcpServerScenarios,
  ...fileShareScenarios,
  ...mirthInstanceScenarios,
  ...adManagerInstanceScenarios,
  ...emailSanitizerScenarios,
  ...mailReviewScenarios,
];
