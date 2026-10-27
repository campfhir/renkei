/** One Jira space template (migration 124), as stored; the document is parsed JSON, unread. */
export interface JiraSpaceTemplateRecord {
  id: string;
  cloudId: string;
  siteUrl: string | null;
  name: string;
  nameKey: string;
  description: string | null;
  sourceSpaceKey: string | null;
  document: unknown;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The organization's space templates, unique by (cloudId, nameKey). */
export interface JiraSpaceTemplateStore {
  /**
   * Save under (cloudId, nameKey). Taken already: with `overwrite`, the
   * row's name, description, source, site and document are replaced (its
   * creation kept); without, nothing changes and the answer is null — even
   * when two saves race.
   */
  save(
    input: {
      cloudId: string;
      siteUrl: string | null;
      name: string;
      nameKey: string;
      description: string | null;
      sourceSpaceKey: string | null;
      document: unknown;
      subject: string;
    },
    options: { overwrite: boolean }
  ): Promise<JiraSpaceTemplateRecord | null>;
  /**
   * The templates matching an id or a name key, this site's first, then by
   * id. Several only by name: one per site.
   */
  find(
    cloudId: string,
    reference: { id: string } | { nameKey: string }
  ): Promise<JiraSpaceTemplateRecord[]>;
  /** Every template, by name key (ties by id), at most `limit`. */
  list(limit: number): Promise<JiraSpaceTemplateRecord[]>;
  delete(id: string): Promise<boolean>;
}
