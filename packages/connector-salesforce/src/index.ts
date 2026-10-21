/**
 * @renkei/connector-salesforce — the pure Salesforce logic both Salesforce
 * connectors share: the pinned API version and the org host, record ids,
 * SOQL safety, checking writes against the describe, relationship paths
 * between objects, report runs shaped for reading, and what a connector
 * keeps away from the model.
 *
 * Deliberately dependency- and I/O-free (the connector-onbase shape):
 * Salesforce is internet SaaS, so HTTP happens in apps/web through the
 * delegate's authenticated fetch. See docs/salesforce-connectors-design.md.
 */

export {
  SALESFORCE_API_VERSION,
  MY_DOMAIN_SUFFIXES,
  dataPath,
  parseMyDomain,
  sameOrg,
  parseIdentityUrl,
  salesforceAccountId,
  type MyDomainError,
} from './api';
export { isSalesforceId, to18, sameId, keyPrefix } from './ids';
export {
  MAX_ORGS,
  orgKeyOf,
  orgSecretName,
  orgsFromSettings,
  orgForInstance,
  findOrg,
  validateOrg,
  type SalesforceOrg,
} from './orgs';
export {
  soqlString,
  soqlContains,
  isSoqlIdentifier,
  checkSelectQuery,
  type CheckedQuery,
} from './soql';
export {
  checkWrite,
  findByNameOrLabel,
  similarFieldNames,
  readOnlyReason,
  validForIndexes,
  summarizeDescribe,
  nameFieldOf,
  isSystemObject,
  sortObjectsForListing,
  type DescribeSObject,
  type DescribeField,
  type PicklistEntry,
  type ChildRelationship,
  type RecordTypeInfo,
  type GlobalSObject,
  type WriteCheck,
  type WriteCheckOptions,
} from './describe';
export { findRelationshipPaths, type RelationshipPath } from './relationships';
export {
  shapeReportRun,
  instanceStatus,
  type ShapedReportRun,
  type ReportGroupRow,
} from './reports';
export {
  EMPTY_POLICY,
  HIDDEN_CLASSIFICATIONS,
  MAX_EXCLUSIONS,
  policyFromSettings,
  validatePolicy,
  isEmptyPolicy,
  isObjectHidden,
  hiddenFieldsOf,
  soqlIdentifierParts,
  soqlFromNames,
  policyRefusalForQuery,
  recordTypesIn,
  scrubRecords,
  reportNamesHidden,
  type DataPolicy,
} from './policy';
