'use server';

/**
 * The usage page's report — one person's overall utilization.
 *
 * The subject is the SESSION's, never a parameter: this page answers "what
 * have I used", and there is no argument a caller can send that turns it
 * into someone else's answer. Operators who want another person's numbers
 * pick them on Organization usage, which checks their role on every call.
 */

import { getSessionFromCookies } from '@/lib/session';
import { ROLE_OPERATOR, ROLE_USER } from '@/lib/access';
import { safeTimeZone } from '../usage/window';
import {
  getAgentUtilization,
  getFailureSignatures,
  getUtilizationTotals,
  type AgentUtilizationRow,
  type FailureSignature,
  type UtilizationTotals,
} from '@/lib/usage/user-utilization';
import {
  getMostEfficientAgents,
  getOrgDailySeries,
  getSurfaceTokenTotals,
  getTokensByModel,
  getTopAgentsByTokens,
  getTopToolsOrg,
  type EfficientAgentRow,
  type ModelTokenRow,
  type OrgTokenTotals,
  type OrgToolRow,
  type TopAgentRow,
} from '@/lib/usage/org-usage';
import { getVoiceTotals, ZERO_VOICE_TOTALS, type VoiceTotals } from '@/lib/usage/voice-usage';
import { getImageTotals, ZERO_IMAGE_TOTALS, type ImageTotals } from '@/lib/usage/image-usage';
import {
  getDocumentTotals,
  ZERO_DOCUMENT_TOTALS,
  type DocumentTotals,
} from '@/lib/usage/document-usage';
import { listImageModels } from '@/lib/chat/models';
import { resolveVoiceProvider } from '@/lib/voice/config';
import {
  activityCells,
  bucketOrgSeries,
  seriesGranularity,
  type ActivityCell,
  type OrgBucket,
} from '../admin/usage/window';
import { resolvePeriod } from './window';
import { logger } from '@/lib/logger';

export interface UtilizationReport {
  periodKey: string;
  days: number;
  /** The IANA zone every day in the report is bucketed in. */
  timeZone: string;
  totals: UtilizationTotals;
  /**
   * The same buckets Organization usage charts — tokens split by surface,
   * runs, tool calls — read for this person alone.
   */
  series: OrgBucket[];
  /** One square per day (or hour) of the window, for the activity calendar. */
  cells: ActivityCell[];
  /** This person's tokens by model. */
  byModel: ModelTokenRow[];
  /** This person's agents by tokens spent. */
  topAgents: TopAgentRow[];
  /** The tools this person called most, from a chat client or through their agents. */
  topTools: OrgToolRow[];
  agents: AgentUtilizationRow[];
  attention: FailureSignature[];
  /** This person's own tokens, split the same way Organization Usage splits the org's. */
  surfaceTokens: OrgTokenTotals;
  /** This person's own agents, ranked by tool calls per token — no active-user rate here, there's only one person. */
  efficientAgents: EfficientAgentRow[];
  /** Replies read to them and their own speech recognised. */
  voice: VoiceTotals;
  /** The org has a speech service; with none, and nothing ever used, the voice card is left out. */
  voiceAvailable: boolean;
  /** Pictures drawn for them. */
  image: ImageTotals;
  /** The org has an image generation model; with none, and nothing ever drawn, the image card is left out. */
  imageAvailable: boolean;
  /** Summaries and descriptions the model wrote for files they uploaded, and their OCR reads. */
  document: DocumentTotals;
  error?: string;
  signedOut?: boolean;
}

const ZERO: UtilizationTotals = {
  inputTokens: 0,
  outputTokens: 0,
  chatInputTokens: 0,
  chatOutputTokens: 0,
  runs: 0,
  failures: 0,
  toolCalls: 0,
  toolErrors: 0,
};

const ZERO_SURFACE_TOKENS: OrgTokenTotals = {
  chat: { input: 0, output: 0 },
  chatProjects: { input: 0, output: 0 },
  images: { input: 0, output: 0 },
  documents: { input: 0, output: 0 },
  codeProjects: { input: 0, output: 0 },
  agents: { input: 0, output: 0 },
};

export async function getUtilizationReport(
  requestedPeriod?: string,
  requestedTimeZone?: string
): Promise<UtilizationReport> {
  const period = resolvePeriod(requestedPeriod);
  // The viewer's zone, validated (an unknown name would fail the query):
  // every ledger is bucketed in it, so "today" means their today.
  const timeZone = safeTimeZone(requestedTimeZone);
  const empty: UtilizationReport = {
    periodKey: period.key,
    days: period.days,
    timeZone,
    totals: ZERO,
    series: [],
    cells: [],
    byModel: [],
    topAgents: [],
    topTools: [],
    agents: [],
    attention: [],
    surfaceTokens: ZERO_SURFACE_TOKENS,
    efficientAgents: [],
    voice: ZERO_VOICE_TOTALS,
    voiceAvailable: false,
    image: ZERO_IMAGE_TOTALS,
    imageAvailable: false,
    document: ZERO_DOCUMENT_TOTALS,
  };

  const session = await getSessionFromCookies();
  if (!session) return { ...empty, error: 'Sign in to see your usage', signedOut: true };
  if (!session.roles.includes(ROLE_OPERATOR) && !session.roles.includes(ROLE_USER)) {
    return { ...empty, error: 'Your account has no role in this tenant' };
  }

  const subject = session.subject;
  const span = { days: period.days, endOffsetDays: period.endOffsetDays };

  try {
    const [
      totals,
      daily,
      agents,
      attention,
      surfaceTokens,
      efficientAgents,
      voice,
      voiceProvider,
      image,
      imageModels,
      document,
      byModel,
      topAgents,
      topTools,
    ] = await Promise.all([
      getUtilizationTotals(subject, span, timeZone),
      getOrgDailySeries(span, timeZone, subject, seriesGranularity(period.days)),
      getAgentUtilization(subject, span, timeZone),
      getFailureSignatures(subject, span, timeZone),
      getSurfaceTokenTotals(span, timeZone, subject),
      getMostEfficientAgents(span, timeZone, 10, 3, subject),
      getVoiceTotals(span, timeZone, subject),
      resolveVoiceProvider(),
      getImageTotals(span, timeZone, subject),
      listImageModels(),
      getDocumentTotals(span, timeZone, subject),
      getTokensByModel(span, timeZone, subject),
      getTopAgentsByTokens(span, timeZone, subject),
      getTopToolsOrg(span, timeZone, subject),
    ]);
    const now = new Date();
    return {
      periodKey: period.key,
      days: period.days,
      timeZone,
      totals,
      series: bucketOrgSeries(daily, span, now, timeZone),
      cells: activityCells(daily, span, now, timeZone),
      byModel,
      topAgents,
      topTools,
      agents,
      attention,
      surfaceTokens,
      efficientAgents,
      voice,
      voiceAvailable: voiceProvider !== null,
      image,
      imageAvailable: imageModels.length > 0,
      document,
    };
  } catch (error) {
    logger.error('Could not read the utilization report: {error}', {
      component: 'actions/utilization',
      subject,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ...empty, error: error instanceof Error ? error.message : 'Could not read usage' };
  }
}
