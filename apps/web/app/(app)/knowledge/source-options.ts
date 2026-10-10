/**
 * The source filter chips.
 *
 * A plain module rather than a constant inside the client component, so the
 * list can be checked against the vocabulary the search actually accepts —
 * see source-options.test.ts. SharePoint was indexed, searchable and
 * labelled on its own cards for a while with no chip to filter by, because
 * these two lists are written in different files and nothing compared them.
 */
export const SOURCE_OPTIONS: { id: string; label: string }[] = [
  // No Outlook chip of any kind: mail, calendar and To Do are personal and
  // are never indexed.
  { id: 'confluence', label: 'Confluence' },
  { id: 'jira', label: 'Jira' },
  { id: 'sharepoint', label: 'SharePoint' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'webex', label: 'WebEx' },
  { id: 'notes', label: 'My notes' },
];
