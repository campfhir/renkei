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
  takesChanges,
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
export {
  METADATA_NAMESPACE,
  FIELD_TYPES,
  isDeveloperName,
  developerNameOf,
  checkFieldSpec,
  checkValidationRuleSpec,
  xmlEscape,
  fieldXml,
  validationRuleXml,
  packageXml,
  objectFileXml,
  buildObjectChildrenPackage,
  parseDeployResult,
  type FieldType,
  type FieldSpec,
  type PicklistValueSpec,
  type ValidationRuleSpec,
  type PackageMember,
  type DeployFailure,
  type DeployOutcome,
} from './metadata';
export { metadataBody, metadataFile, metadataFileName } from './metadata-xml';
export {
  layoutSections,
  layoutFieldSet,
  mergeLayoutChanges,
  type FieldBehavior,
  type LayoutChanges,
  type LayoutSectionView,
} from './layouts';
export {
  mergeFieldChanges,
  mergePicklistChanges,
  existingFieldXml,
  checkObjectSpec,
  buildObjectPackage,
  SHARING_MODELS,
  type ChangeRow,
  type FieldChanges,
  type ObjectSpec,
  type SharingModel,
} from './changes';
export {
  impliedRights,
  rightsLabel,
  unionRights,
  checkPermissionSetName,
  permissionSetFile,
  type ObjectRights,
  type NewPermissionSetSpec,
} from './permission-sets';
export {
  FORECAST_CATEGORIES,
  STANDARD_VALUE_SETS,
  PROCESS_FIELDS,
  mergeValueList,
  mergeGlobalValueSetChanges,
  mergeStandardValueSetChanges,
  mergeAvailable,
  mergeRecordTypePicklist,
  mergeBusinessProcessValues,
  standardValueSetOf,
  fieldsOfValueSet,
  processOf,
  availableValueName,
  type ForecastCategory,
  type NewValue,
  type PicklistChanges,
  type ValueRow,
  type StandardValueRead,
  type AvailabilityChange,
} from './picklists';
export {
  PROCESS_OBJECTS,
  objectChildXml,
  checkRecordTypeSpec,
  recordTypeMetadata,
  recordTypePicklists,
  profileOverlayFile,
  type RecordTypeSpec,
  type ProfileRecordTypeAccess,
} from './record-types';
export {
  REPORT_TYPE_CATEGORIES,
  REPORT_FORMATS,
  REPORT_SUMMARIES,
  REPORT_FILTER_OPERATORS,
  DATE_GRANULARITIES,
  DATE_INTERVALS,
  FOLDER_ACCESS,
  reportableFields,
  checkReportTypeSpec,
  buildReportTypePackage,
  checkFilterLogic,
  checkReportSpec,
  buildReportPackage,
  isCustomReportType,
  reportFileColumn,
  type ReportObjectInfo,
  type ReportTypeSpec,
  type ReportSpec,
  type FolderAccess,
} from './report-metadata';
