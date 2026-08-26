/**
 * @renkei/connector-microsoft — the Microsoft Graph connector's ingress
 * surface: mail (inbox), calendar, To Do tasks, and drive documents
 * (SharePoint document libraries and personal OneDrive), per-user.
 *
 * The package covers TWO content families whose access rules genuinely
 * differ, and conflating them is the mistake this header exists to prevent:
 *
 *   PERSONAL (mail, calendar, tasks) — indexed into the owner's view alone,
 *   refId `${upn}/${kind}/${id}`, ownership IS the ACL (verifier.ts).
 *
 *   DOCUMENTS (drives) — shared by nature, refId `${driveId}/${itemId}` with
 *   no owner segment, ACL answered LIVE per reader against Graph
 *   (drive-verifier.ts). Stored under their own knowledge provider key so
 *   the right verifier is chosen by a column rather than by sniffing a ref.
 *
 * Data contract (RENKEI.md, connector contract):
 * 1. Content stored: message/event/task/document content flows through delta
 *    rounds into the knowledge index; this package itself persists nothing.
 * 2. Metadata indexed: personal items carry their owner's UPN in the refId;
 *    documents carry drive and item ids, plus cTag for change detection.
 * 3. Retrieval-only: everything else stays live behind graphRequest.
 * 4. Sharing: personal items are indexed only into their OWNER's view and
 *    never cross users. Documents ARE shared — indexing is bounded by the
 *    watching user's access, but disclosure is decided per reader at
 *    retrieval, never by who indexed the file.
 * 5. verifyAccess: ownership equality for personal items; a live per-caller
 *    Graph $batch for documents, where the provider's own answer is the only
 *    tractable and correct one.
 *
 * Ingestion is delegated-token scoped (each user's own OAuth grant via
 * @renkei/provider-grants' MicrosoftAdapter) — there is no org credential,
 * so the connector can never index more than each user can see.
 */

/** The connector key used in connector_configs, capability descriptors, and event rows. */
export const MICROSOFT_CONNECTOR = 'microsoft';

export { GRAPH_BASE_URL, graphRequest } from './client';
export {
  BATCH_CHUNK_SIZE,
  graphBatch,
  summarizeBatch,
  withCategoryChanges,
  type BatchRequestItem,
  type BatchResultItem,
  type GraphBatchOptions,
} from './mail-batch';
export {
  buildMailQueryPath,
  clientSideSelect,
  hasClientSideFilter,
  matchesClientSide,
  type MailSearchFilters,
  type MailQueryOptions,
} from './mail-filter';
export { graphUploadViaSession, UPLOAD_SESSION_CHUNK_BYTES } from './upload-session';
export {
  microsoftRefId,
  ownerOfMicrosoftRefId,
  objectIdOfMicrosoftRefId,
  type MicrosoftRefKind,
} from './refs';
export { createMicrosoftAccessVerifier } from './verifier';
export {
  SHAREPOINT_KNOWLEDGE_PROVIDER,
  sharepointRefId,
  partsOfSharepointRefId,
} from './drive-refs';
export { createSharepointAccessVerifier, type MicrosoftCredentialLookup } from './drive-verifier';
export {
  graphDownload,
  DRIVE_CONTENT_MAX_BYTES,
  type GraphContent,
  type GraphDownloadOptions,
} from './content';
export {
  GRAPH_SUBSCRIPTION_MINUTES,
  createGraphSubscription,
  renewGraphSubscription,
  deleteGraphSubscription,
  listGraphSubscriptions,
  type CreateSubscriptionOptions,
  type GraphSubscription,
} from './subscriptions';
export {
  initialDeltaUrl,
  runDeltaRound,
  type DeltaKind,
  type InitialDeltaOptions,
  type DeltaRoundOptions,
} from './delta';
