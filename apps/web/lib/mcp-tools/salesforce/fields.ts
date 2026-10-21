/**
 * The input fields the salesforce_ tools share, so every tool names an
 * object, a record and a person the same way.
 */

import { z } from 'zod';

export const objectField = z
  .string()
  .min(1)
  .describe(
    'The object: its API name (Account, Site_Visit__c, npsp__Allocation__c) or its label ' +
      '("Site Visit", "Site Visits"). Standard and custom objects alike; salesforce_list_objects lists them.'
  );

export const recordField = z
  .string()
  .min(1)
  .describe(
    'The record: its id (15 or 18 characters), its exact name, or words from its name or the ' +
      'fields that identify it ("Acme visit March"). A name matching more than one record is refused with their ids.'
  );

/** A record anywhere: an id alone (its prefix names the object), or object + record. */
export const recordRefField = z
  .object({
    object: objectField
      .optional()
      .describe('The object, when the record is named rather than given by id.'),
    record: recordField,
  })
  .describe('A record: { record: "<id>" }, or { object: "Contact", record: "Jane Doe" }.');

/** Field values to write, keyed by API name or label. */
export const fieldsField = z
  .record(z.string(), z.unknown())
  .describe(
    'Field values keyed by API name or label: { "Stage__c": "Completed", "Visit Date": "2026-10-21" }. ' +
      "Lookups take the related record's id or name; picklists a value or its label; dates YYYY-MM-DD; " +
      'date-times ISO 8601; checkboxes true/false; null clears a field. Values are checked against ' +
      'the object before anything is sent.'
  );

export const limitField = (max: number, fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`How many to return (default ${fallback}, at most ${max}).`);
