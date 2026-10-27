import { orderBy } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { enabledModelFromRow } from './postgres';
import type { ChatModelStore } from './types';

/** `coalesce(settings->>'apiSurface', '') in ('images', 'flux')`. */
function isImageModel(row: Row<'llm_model_configs'>): boolean {
  const settings: unknown = row.settings;
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return false;
  const surface: unknown = Reflect.get(settings, 'apiSurface');
  // ->> renders a JSON value as text: a string as itself, anything else as its JSON.
  const text =
    surface === undefined || surface === null
      ? ''
      : typeof surface === 'string'
        ? surface
        : JSON.stringify(surface);
  return text === 'images' || text === 'flux';
}

export function memoryChatModels(tables: MemoryTables): ChatModelStore {
  return {
    async listChatModels() {
      return orderBy(
        tables.select('llm_model_configs', (r) => r.enabled && !isImageModel(r)),
        [(r) => r.is_default, 'desc'],
        [(r) => r.label],
        [(r) => r.id]
      ).map(enabledModelFromRow);
    },
    async listImageModels() {
      return orderBy(
        tables.select('llm_model_configs', (r) => r.enabled && isImageModel(r)),
        [(r) => r.label],
        [(r) => r.id]
      ).map(enabledModelFromRow);
    },
  };
}
