import { orderBy } from '../../memory/order';
import { uniqueViolation, type MemoryTables } from '../../memory/tables';
import type { CodeTemplateStore } from './types';

export function memoryCodeTemplates(tables: MemoryTables): CodeTemplateStore {
  // The template pages answer a taken name as "duplicate".
  const refuseTakenProjectName = (name: string, except?: string) => {
    if (tables.first('code_project_templates', (r) => r.name === name && r.id !== except)) {
      throw uniqueViolation('code_project_templates', 'idx_code_project_templates_name');
    }
  };
  const blank = () => {
    const now = new Date();
    return { id: globalThis.crypto.randomUUID(), created_at: now, updated_at: now };
  };
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
      refuseTakenProjectName(input.name);
      return tables.insert('code_project_templates', { ...blank(), ...input }).id;
    },
    async updateProjectTemplate(id, input) {
      const wanted = id;
      refuseTakenProjectName(input.name, wanted);
      return (
        tables.update('code_project_templates', (r) => r.id === wanted, {
          ...input,
          updated_at: new Date(),
        }).length > 0
      );
    },
    async deleteProjectTemplate(id) {
      const wanted = id;
      return tables.delete('code_project_templates', (r) => r.id === wanted).length > 0;
    },
  };
}
