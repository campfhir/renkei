import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { CodeTemplateStore } from './types';

export function memoryCodeTemplates(tables: MemoryTables): CodeTemplateStore {
  return {
    async listProjectTemplates() {
      return orderBy(tables.select('code_project_templates'), [(r) => r.name], [(r) => r.id]).map(
        (r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          instructions: r.instructions,
        })
      );
    },
    async createProjectTemplate(input) {
      return tables.insert('code_project_templates', input).id;
    },
    async updateProjectTemplate(id, input) {
      const wanted = tables.param('code_project_templates', 'id', id);
      return (
        tables.update('code_project_templates', (r) => r.id === wanted, {
          ...input,
          updated_at: new Date(),
        }).length > 0
      );
    },
    async deleteProjectTemplate(id) {
      const wanted = tables.param('code_project_templates', 'id', id);
      return tables.delete('code_project_templates', (r) => r.id === wanted).length > 0;
    },
    async listPipelineTemplates(provider) {
      return orderBy(
        tables.select('pipeline_templates', (r) => !provider || r.provider === provider),
        [(r) => r.provider],
        [(r) => r.name],
        [(r) => r.id]
      ).map((r) => ({
        id: r.id,
        provider: r.provider,
        name: r.name,
        description: r.description,
        body: r.body,
      }));
    },
    async createPipelineTemplate(input) {
      return tables.insert('pipeline_templates', input).id;
    },
    async updatePipelineTemplate(id, input) {
      const wanted = tables.param('pipeline_templates', 'id', id);
      return (
        tables.update('pipeline_templates', (r) => r.id === wanted, {
          ...input,
          updated_at: new Date(),
        }).length > 0
      );
    },
    async deletePipelineTemplate(id) {
      const wanted = tables.param('pipeline_templates', 'id', id);
      return tables.delete('pipeline_templates', (r) => r.id === wanted).length > 0;
    },
  };
}
