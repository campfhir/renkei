/**
 * The admin-managed catalogs behind the code pages' pickers: project
 * instruction templates (code_project_templates) and pipeline file
 * templates (pipeline_templates). A duplicate name is refused with
 * 23505, as the unique indexes refuse it.
 */

export interface CodeProjectTemplateRecord {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
}

export interface PipelineTemplateRecord {
  id: string;
  provider: string;
  name: string;
  description: string | null;
  body: string;
}

export interface CodeTemplateStore {
  /** Every project template, by name (ties by id). */
  listProjectTemplates(): Promise<CodeProjectTemplateRecord[]>;
  createProjectTemplate(input: Omit<CodeProjectTemplateRecord, 'id'>): Promise<string>;
  /** False when there is no such template. */
  updateProjectTemplate(id: string, input: Omit<CodeProjectTemplateRecord, 'id'>): Promise<boolean>;
  deleteProjectTemplate(id: string): Promise<boolean>;
  /** Pipeline templates, of one host or all, by host then name (ties by id). */
  listPipelineTemplates(provider?: string): Promise<PipelineTemplateRecord[]>;
  createPipelineTemplate(input: Omit<PipelineTemplateRecord, 'id'>): Promise<string>;
  updatePipelineTemplate(id: string, input: Omit<PipelineTemplateRecord, 'id'>): Promise<boolean>;
  deletePipelineTemplate(id: string): Promise<boolean>;
}
