/**
 * Reading the components a proposal changes whole — a record type, a
 * business process, a global value set, a standard value set — and the
 * hash each `component-unchanged` precondition compares on apply
 * (plan.ts). Record types and processes come from the Tooling API's
 * `Metadata` (a one-row query each); a global value set likewise; a
 * standard value set has no whole read anywhere, so it is assembled from
 * the field's describe and, for the sets with flags (stages, statuses,
 * priorities), the status objects that carry them. A custom report type
 * has no Tooling API object at all, so it is read with the Metadata API's
 * SOAP readMetadata, whose envelope — the session goes in it — the
 * delegate writes (apps/worker-delegate/src/salesforce-soap.ts).
 */

import {
  isDeveloperName,
  normalizeReportType,
  readMetadataRecords,
  SALESFORCE_API_VERSION,
  soqlString,
  standardValueSetOf,
  type StandardValueRead,
} from '@renkei/connector-salesforce';
import { refusalTextOf } from '@/lib/grant-refusals';
import {
  rec,
  sfQuery,
  str,
  type SalesforceAccess,
  type SalesforceCallContext,
} from '@/lib/mcp-tools/salesforce/client';
import { describeObject, invalidateDescribe } from '@/lib/mcp-tools/salesforce/schema';
import { fingerprintOf, toolingQuery } from './tooling';

export interface LiveReportType {
  /** The developer name, without `__c`. */
  name: string;
  /** As readMetadata gives it, sections and their columns always arrays. */
  metadata: Record<string, unknown>;
  fingerprint: string;
}

/**
 * A custom report type whole, by its developer name (with or without
 * `__c`), through the delegate's readMetadata; null when there is none.
 */
export async function readReportType(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  name: string
): Promise<LiveReportType | null | string> {
  const developerName = name.trim().replace(/__c$/i, '');
  if (!isDeveloperName(developerName, 50)) return `${name} is not a report type’s API name.`;
  let response: Response;
  try {
    response = await access.auth(
      `${access.instanceUrl}/services/Soap/m/${SALESFORCE_API_VERSION}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
        body:
          '<readMetadata xmlns="http://soap.sforce.com/2006/04/metadata">' +
          `<type>ReportType</type><fullNames>${developerName}</fullNames></readMetadata>`,
        signal: AbortSignal.timeout(60_000),
      }
    );
  } catch (error) {
    return `Could not reach Salesforce to read the report type: ${error instanceof Error ? error.message : String(error)}`;
  }
  const refused = refusalTextOf(response, 'Salesforce Admin');
  if (refused) return refused;
  const read = readMetadataRecords(await response.text().catch(() => ''));
  if (!Array.isArray(read)) return `Salesforce would not read the report type: ${read.fault}`;
  const record = read[0];
  if (!record || !record.baseObject) return null;
  const metadata = normalizeReportType(record);
  return { name: developerName, metadata, fingerprint: fingerprintOf(metadata) };
}

export interface RecordTypeRef {
  id: string;
  label: string;
  developerName: string;
  active: boolean;
  businessProcessId: string;
  description: string;
}

/** An object's record types (not the master), by label. */
export async function listRecordTypes(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string
): Promise<RecordTypeRef[] | string> {
  const found = await sfQuery(
    context,
    access,
    `SELECT Id, Name, DeveloperName, IsActive, BusinessProcessId, Description FROM RecordType WHERE SobjectType = ${soqlString(object)} ORDER BY Name`
  );
  if (!found.ok) return found.error;
  return found.records.map((row) => ({
    id: str(row.Id),
    label: str(row.Name),
    developerName: str(row.DeveloperName),
    active: row.IsActive === true,
    businessProcessId: str(row.BusinessProcessId),
    description: str(row.Description),
  }));
}

/** A record type by developer name or label among an object's, or why not. */
export function findRecordType(types: RecordTypeRef[], ref: string): RecordTypeRef | string {
  const wanted = ref.trim().toLowerCase();
  const match = types.find(
    (rt) => rt.developerName.toLowerCase() === wanted || rt.label.toLowerCase() === wanted
  );
  if (match) return match;
  return types.length === 0
    ? 'That object has no record types.'
    : `No record type "${ref}": the object’s are ${types.map((rt) => `${rt.label} (${rt.developerName})`).join(', ')}.`;
}

export interface LiveWhole {
  id: string;
  /** The member name within its object (a record type's developer name, a process's name). */
  name: string;
  metadata: Record<string, unknown>;
  fingerprint: string;
}

async function oneMetadataRow(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  soql: string
): Promise<Record<string, unknown> | null | string> {
  const found = await toolingQuery(context, access, soql);
  if (!found.ok) return found.error;
  return found.records[0] ?? null;
}

/** One record type, whole. */
export async function readRecordType(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  id: string
): Promise<LiveWhole | null | string> {
  const row = await oneMetadataRow(
    context,
    access,
    `SELECT Id, DeveloperName, FullName, Metadata FROM RecordType WHERE Id = ${soqlString(id)} LIMIT 1`
  );
  if (!row || typeof row === 'string') return row;
  const metadata = rec(row.Metadata);
  return {
    id: str(row.Id),
    name: str(row.DeveloperName) || (str(row.FullName).split('.').pop() ?? ''),
    metadata,
    fingerprint: fingerprintOf(metadata),
  };
}

/** One business process, whole. */
export async function readBusinessProcess(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  id: string
): Promise<LiveWhole | null | string> {
  const row = await oneMetadataRow(
    context,
    access,
    `SELECT Id, Name, FullName, Metadata FROM BusinessProcess WHERE Id = ${soqlString(id)} LIMIT 1`
  );
  if (!row || typeof row === 'string') return row;
  const metadata = rec(row.Metadata);
  return {
    id: str(row.Id),
    name: str(row.Name) || (str(row.FullName).split('.').pop() ?? ''),
    metadata,
    fingerprint: fingerprintOf(metadata),
  };
}

/** An object's business processes (Opportunity, Lead, Case, Solution), by name. */
export async function listBusinessProcesses(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  object: string
): Promise<{ id: string; name: string; active: boolean }[] | string> {
  const found = await sfQuery(
    context,
    access,
    `SELECT Id, Name, IsActive FROM BusinessProcess WHERE TableEnumOrId = ${soqlString(object)} ORDER BY Name`
  );
  if (!found.ok) return found.error;
  return found.records.map((row) => ({
    id: str(row.Id),
    name: str(row.Name),
    active: row.IsActive === true,
  }));
}

export interface LiveGlobalValueSet extends LiveWhole {
  label: string;
}

/** A global value set by its API name, whole; the member name keeps any namespace. */
export async function readGlobalValueSet(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  name: string
): Promise<LiveGlobalValueSet | null | string> {
  const [namespace, developerName] = name.includes('__') ? name.split('__', 2) : ['', name];
  const row = await oneMetadataRow(
    context,
    access,
    `SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, Metadata FROM GlobalValueSet WHERE DeveloperName = ${soqlString(developerName)}${namespace ? ` AND NamespacePrefix = ${soqlString(namespace)}` : ''} LIMIT 1`
  );
  if (!row || typeof row === 'string') return row;
  const metadata = rec(row.Metadata);
  const prefix = str(row.NamespacePrefix);
  return {
    id: str(row.Id),
    name: prefix ? `${prefix}__${str(row.DeveloperName)}` : str(row.DeveloperName),
    label: str(row.MasterLabel),
    metadata,
    fingerprint: fingerprintOf(metadata),
  };
}

/** The Metadata API's forecast categories, from the names OpportunityStage reports. */
function forecastCategory(name: string): string {
  switch (name) {
    case 'Best Case':
      return 'BestCase';
    case 'Commit':
      return 'Forecast';
    default:
      return name.replace(/\s+/g, '');
  }
}

/** The status object carrying a set's flags, with how to read each row's. */
const STATUS_OBJECTS: Record<
  string,
  {
    soql: string;
    flags: (row: Record<string, unknown>) => Record<string, string | number | boolean>;
  }
> = {
  OpportunityStage: {
    soql: 'SELECT ApiName, MasterLabel, IsActive, IsClosed, IsWon, ForecastCategoryName, DefaultProbability, SortOrder FROM OpportunityStage ORDER BY SortOrder',
    flags: (row) => ({
      closed: row.IsClosed === true,
      won: row.IsWon === true,
      forecastCategory: forecastCategory(str(row.ForecastCategoryName)),
      probability: typeof row.DefaultProbability === 'number' ? row.DefaultProbability : 0,
    }),
  },
  LeadStatus: {
    soql: 'SELECT ApiName, MasterLabel, IsConverted, IsDefault, SortOrder FROM LeadStatus ORDER BY SortOrder',
    flags: (row) => ({ converted: row.IsConverted === true }),
  },
  CaseStatus: {
    soql: 'SELECT ApiName, MasterLabel, IsClosed, IsDefault, SortOrder FROM CaseStatus ORDER BY SortOrder',
    flags: (row) => ({ closed: row.IsClosed === true }),
  },
  TaskStatus: {
    soql: 'SELECT ApiName, MasterLabel, IsClosed, IsDefault, SortOrder FROM TaskStatus ORDER BY SortOrder',
    flags: (row) => ({ closed: row.IsClosed === true }),
  },
  TaskPriority: {
    soql: 'SELECT ApiName, MasterLabel, IsHighPriority, IsDefault, SortOrder FROM TaskPriority ORDER BY SortOrder',
    flags: (row) => ({ highPriority: row.IsHighPriority === true }),
  },
};

export interface LiveStandardValueSet {
  set: string;
  values: StandardValueRead[];
  fingerprint: string;
}

/**
 * A standard value set as it can be read: the field's values from a fresh
 * describe (active ones), with each value's flags from its status object
 * where the set has them — the stages with their inactive ones too.
 */
export async function readStandardValueSet(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  set: string,
  object: string,
  field: string
): Promise<LiveStandardValueSet | string> {
  invalidateDescribe(access, object);
  const describe = await describeObject(context, access, object);
  if (typeof describe === 'string') return describe;
  const described = describe.fields.find((f) => f.name.toLowerCase() === field.toLowerCase());
  if (!described) return `${object} has no field ${field} that you can see.`;
  let values: StandardValueRead[] = (described.picklistValues ?? []).map((entry) => ({
    value: entry.value,
    label: entry.label,
    default: entry.defaultValue === true,
  }));
  const status = STATUS_OBJECTS[set];
  if (status) {
    const found = await sfQuery(context, access, status.soql);
    if (!found.ok) return found.error;
    const rows = found.records;
    const flagsOf = (value: string) => {
      const row = rows.find((r) => str(r.ApiName) === value);
      return row ? status.flags(row) : undefined;
    };
    values = values.map((entry) => {
      const flags = flagsOf(entry.value);
      return flags ? { ...entry, flags } : entry;
    });
    if (set === 'OpportunityStage') {
      // The stages the describe leaves out (inactive), so the set keeps them inactive.
      for (const row of rows) {
        if (row.IsActive === false && !values.some((v) => v.value === str(row.ApiName))) {
          values.push({
            value: str(row.ApiName),
            label: str(row.MasterLabel),
            default: false,
            flags: { ...status.flags(row), isActive: false },
          });
        }
      }
    }
  }
  return { set, values, fingerprint: fingerprintOf(values) };
}

/** A profile by name, with the full name its Metadata API file has ("Admin" for System Administrator). */
export async function readProfile(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  name: string
): Promise<{ id: string; name: string; fullName: string } | string> {
  const row = await oneMetadataRow(
    context,
    access,
    `SELECT Id, Name, FullName FROM Profile WHERE Name = ${soqlString(name.trim())} LIMIT 1`
  );
  if (typeof row === 'string') return row;
  if (!row) return `No profile "${name}" in this org.`;
  return { id: str(row.Id), name: str(row.Name), fullName: str(row.FullName) || str(row.Name) };
}

/**
 * What a whole component's hash is now, for its precondition: the hash,
 * null when it is gone, or why it could not be read.
 */
export async function wholeComponentFingerprint(
  context: SalesforceCallContext,
  access: SalesforceAccess,
  precondition: { type: string; object: string; name: string }
): Promise<string | null | { error: string }> {
  const wrap = (live: { fingerprint: string } | null | string) =>
    typeof live === 'string' ? { error: live } : (live?.fingerprint ?? null);
  switch (precondition.type) {
    case 'RecordType': {
      const types = await listRecordTypes(context, access, precondition.object);
      if (typeof types === 'string') return { error: types };
      const match = types.find((rt) => rt.developerName === precondition.name);
      return match ? wrap(await readRecordType(context, access, match.id)) : null;
    }
    case 'BusinessProcess': {
      const processes = await listBusinessProcesses(context, access, precondition.object);
      if (typeof processes === 'string') return { error: processes };
      const match = processes.find((p) => p.name === precondition.name);
      return match ? wrap(await readBusinessProcess(context, access, match.id)) : null;
    }
    case 'GlobalValueSet':
      return wrap(await readGlobalValueSet(context, access, precondition.name));
    case 'ReportType':
      return wrap(await readReportType(context, access, precondition.name));
    case 'StandardValueSet': {
      const [object, field] = [precondition.object, precondition.name];
      const set = standardValueSetOf(object, field);
      if (!set) return { error: `${object}.${field} has no standard value set.` };
      return wrap(await readStandardValueSet(context, access, set, object, field));
    }
    default:
      return { error: `Cannot check a ${precondition.type}.` };
  }
}
