/**
 * Domain vocabulary for the OnBase Document API (Foundation 26.1), kept to
 * the fields Renkei actually reads. Every shape here mirrors the OpenAPI
 * spec in docs/onbase-rest-api-openapi-spec.json; anything the spec marks
 * optional stays optional here rather than being defaulted, so a server
 * that omits a field is visible as such.
 */

/** Keyword type metadata — the vocabulary a keyword search speaks. */
export interface OnBaseKeywordType {
  id: string;
  /** Localized display name. */
  name?: string;
  /** Untranslated name; matched second during name resolution. */
  systemName?: string;
  dataType?: string;
}

export interface OnBaseDocumentType {
  id: string;
  name?: string;
  systemName?: string;
  documentTypeGroupId?: string;
}

export interface OnBaseDocumentTypeGroup {
  id: string;
  name?: string;
  systemName?: string;
}

export interface OnBaseCustomQuery {
  id: string;
  name?: string;
  systemName?: string;
  /** Usage/purpose prose configured by the OnBase admin. */
  instructions?: string;
  queryType?: string;
}

/**
 * One keyword value. The API represents values as strings whatever the
 * keyword's data type; a blank keyword is an empty `values` list, never an
 * empty string.
 */
export interface OnBaseKeywordValue {
  value?: string;
  /** Response-only: locale/mask formatted rendering. */
  formattedValue?: string;
}

export interface OnBaseKeywordEntry {
  typeId?: string;
  values?: OnBaseKeywordValue[];
}

export interface OnBaseKeywordGroup {
  typeGroupId?: string;
  groupId?: string;
  instanceId?: string;
  keywords: OnBaseKeywordEntry[];
}

/**
 * The whole keyword payload of one document. `keywordGuid` guards
 * restricted keyword integrity: the PUT must echo the value the GET (or the
 * default-keywords endpoint) handed out.
 */
export interface OnBaseKeywordCollection {
  keywordGuid: string;
  items: OnBaseKeywordGroup[];
}

/** One requested keyword change: every value of one keyword type. */
export interface KeywordUpdate {
  typeId: string;
  /** The complete new value list for this type; [] blanks the keyword. */
  values: string[];
}

export type QueryOperator =
  | 'Equal'
  | 'LessThan'
  | 'GreaterThan'
  | 'LessThanEqual'
  | 'GreaterThanEqual'
  | 'NotEqual'
  | 'Literal';

export type QueryRelation = 'And' | 'Or' | 'To';

export interface OnBaseQueryKeyword {
  typeId: string;
  value: string;
  operator?: QueryOperator;
  relation?: QueryRelation;
}

export type QueryTargetKind = 'DocumentType' | 'DocumentTypeGroup' | 'CustomQuery';

export type DisplayColumnType =
  | 'Keyword'
  | 'DocumentId'
  | 'DocumentName'
  | 'DocumentDate'
  | 'ArchivalDate'
  | 'AuthorId'
  | 'Batch'
  | 'DocumentTypeGroup'
  | 'DocumentTypeName';

export interface OnBaseQueryInformation {
  queryType: { type: QueryTargetKind; ids: string[] }[];
  maxResults?: number;
  queryKeywordCollection?: OnBaseQueryKeyword[];
  documentDateRangeCollection?: { start?: string; end?: string }[];
  /** Overrides any preconfigured columns, making result shape predictable. */
  userDisplayColumns?: { keywordTypeId?: string; displayColumnType: DisplayColumnType }[];
}

/** OIDC endpoints Renkei needs from a Hyland IdP discovery document. */
export interface OnBaseIdpEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
}
