/**
 * The admin-managed catalog behind the new code project form's picker:
 * project instruction templates (code_project_templates). A duplicate
 * name is refused with 23505, as the unique index refuses it.
 */

export interface CodeProjectTemplateRecord {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
}

export interface CodeTemplateStore {
  /** Every project template, by name (ties by id). */
  listProjectTemplates(): Promise<CodeProjectTemplateRecord[]>;
  createProjectTemplate(input: Omit<CodeProjectTemplateRecord, 'id'>): Promise<string>;
  /** False when there is no such template. */
  updateProjectTemplate(id: string, input: Omit<CodeProjectTemplateRecord, 'id'>): Promise<boolean>;
  deleteProjectTemplate(id: string): Promise<boolean>;
}
