import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';

/** The default-tools forms' rows: each chat connector, named as the catalog names it. */
export function chatToolOptions(
  connectors: { key: string; count: number; core: boolean }[]
): { key: string; label: string; count: number; core: boolean }[] {
  return connectors.map((option) => ({
    key: option.key,
    label:
      CONNECTOR_CATALOG.find((entry) => entry.capabilityKey === option.key)?.label ?? option.key,
    count: option.count,
    core: option.core,
  }));
}
