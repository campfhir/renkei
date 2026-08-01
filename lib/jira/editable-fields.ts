/**
 * Whitelist of editable issue fields and transformation logic.
 *
 * This module defines which fields can be set via Renkei tools and how user
 * input (e.g., an email address) is transformed into Jira's expected format
 * (e.g., a user object with accountId).
 *
 * The whitelist is explicit: only fields listed here can be edited, preventing
 * accidental exposure of admin-only or read-only fields.
 */

import { z } from 'zod';
import type { UserResolver } from './user-resolver.js';

/**
 * Transforms an email or account ID into a user object for Jira.
 * Jira user fields accept { key: accountId } or { accountId: accountId }.
 * We use the accountId form for clarity.
 */
export function userFieldValue(emailOrAccountId: string): Record<string, unknown> {
  return { accountId: emailOrAccountId };
}

/**
 * Transforms component names or IDs into Jira component objects.
 * Jira accepts { name: componentName } or { id: componentId }.
 * We support both; names are preferred if provided.
 */
export function componentFieldValue(nameOrId: string): Record<string, unknown> {
  if (/^[a-f0-9-]{36}$/.test(nameOrId)) {
    return { id: nameOrId };
  }
  return { name: nameOrId };
}

/**
 * Transforms version names or IDs into Jira version objects.
 * Jira accepts { name: versionName } or { id: versionId }.
 * We support both; names are preferred if provided.
 */
export function versionFieldValue(nameOrId: string): Record<string, unknown> {
  if (/^[a-f0-9-]{36}$/.test(nameOrId)) {
    return { id: nameOrId };
  }
  return { name: nameOrId };
}

/**
 * Schema validators for user input. These mirror what the tools accept.
 */

export const userIdentifierSchema = z
  .string()
  .min(1)
  .describe('Email address or Atlassian account ID');

export const componentIdentifierSchema = z.string().min(1).describe('Component name or ID');

export const versionIdentifierSchema = z.string().min(1).describe('Version name or ID');

/**
 * Field definitions for editable fields. Each entry describes:
 * - schema: Zod schema for validation
 * - transform: Function to convert user input to Jira's expected format
 * - jirasField: The actual Jira field name in the API
 */
interface EditableFieldDefinition {
  schema: z.ZodType;
  transform: (value: unknown) => unknown;
  jiraField: string;
}

export const EDITABLE_FIELDS: Record<string, EditableFieldDefinition> = {
  assignee: {
    schema: userIdentifierSchema,
    transform: (value) => userFieldValue(value as string),
    jiraField: 'assignee',
  },
  reporter: {
    schema: userIdentifierSchema,
    transform: (value) => userFieldValue(value as string),
    jiraField: 'reporter',
  },
  components: {
    schema: z.array(componentIdentifierSchema),
    transform: (value) => (value as string[]).map(componentFieldValue),
    jiraField: 'components',
  },
  fixVersions: {
    schema: z.array(versionIdentifierSchema),
    transform: (value) => (value as string[]).map(versionFieldValue),
    jiraField: 'fixVersions',
  },
  environment: {
    schema: z.string().min(1),
    transform: (value) => value,
    jiraField: 'environment',
  },
  storyPoints: {
    schema: z.number().positive(),
    transform: (value) => value,
    jiraField: 'customfield_10016',
  },
  originalEstimate: {
    schema: z.string().min(1).describe('Duration in Jira format: 1d, 2h, 30m, etc.'),
    transform: (value) => value,
    jiraField: 'timeestimate',
  },
};

/**
 * Validates and transforms a field value. Throws if field is not editable or validation fails.
 */
export function validateAndTransformField(
  fieldName: string,
  value: unknown,
): { jiraField: string; transformedValue: unknown } {
  const definition = EDITABLE_FIELDS[fieldName];
  if (!definition) {
    throw new Error(
      `Field '${fieldName}' is not editable through Renkei. ` +
        `Supported fields: ${Object.keys(EDITABLE_FIELDS).join(', ')}`,
    );
  }

  const parseResult = definition.schema.safeParse(value);
  if (!parseResult.success) {
    throw new Error(`Invalid value for field '${fieldName}': ${parseResult.error.message}`);
  }

  return {
    jiraField: definition.jiraField,
    transformedValue: definition.transform(parseResult.data),
  };
}

/**
 * Resolves user references (email addresses) to cloud IDs.
 * Email addresses in assignee/reporter fields are looked up in Jira.
 * Account IDs and non-user fields are passed through unchanged.
 */
export async function resolveUserFields(
  fieldUpdates: Record<string, unknown>,
  resolver: UserResolver | null | undefined,
): Promise<Record<string, unknown>> {
  if (!resolver) {
    return fieldUpdates;
  }

  const resolved: Record<string, unknown> = {};

  for (const [fieldName, value] of Object.entries(fieldUpdates)) {
    if (value === undefined || value === null || (fieldName !== 'assignee' && fieldName !== 'reporter')) {
      resolved[fieldName] = value;
      continue;
    }

    if (typeof value === 'string') {
      resolved[fieldName] = await resolver.resolve(value);
    } else {
      resolved[fieldName] = value;
    }
  }

  return resolved;
}

/**
 * Helper to build a fields object for Jira API calls.
 * Accepts a Record of field names to values (as users would specify them)
 * and returns a Record ready for the Jira API with transformations applied.
 */
export function buildJiraFields(fieldUpdates: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [fieldName, value] of Object.entries(fieldUpdates)) {
    if (value === undefined || value === null) {
      continue;
    }
    const { jiraField, transformedValue } = validateAndTransformField(fieldName, value);
    result[jiraField] = transformedValue;
  }

  return result;
}

/**
 * Processes custom fields, passing them through to the API with minimal transformation.
 * Custom fields are identified by customfield_XXXXX pattern.
 * The Jira API is flexible enough to accept most common data types directly.
 */
export function processCustomFields(customFields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [fieldId, value] of Object.entries(customFields)) {
    if (value === undefined || value === null) {
      continue;
    }

    // Validate it looks like a custom field ID
    if (!fieldId.startsWith('customfield_')) {
      throw new Error(
        `Invalid custom field ID '${fieldId}'. Custom field IDs must start with 'customfield_' ` +
          `(e.g., 'customfield_10016'). Use list_fields to find custom field IDs.`
      );
    }

    // For most custom field types, pass the value through directly.
    // The Jira API handles transformation for common types:
    // - Strings: text fields
    // - Numbers: numeric fields
    // - Arrays: multi-select fields
    // - Objects with 'id' or 'accountId': user/link fields
    result[fieldId] = value;
  }

  return result;
}
