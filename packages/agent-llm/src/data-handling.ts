/**
 * What a model configuration says about where a request's data goes and
 * what the provider keeps of it — operator-entered facts on the
 * `llm_model_configs.settings` jsonb, not anything the code can verify.
 * They exist so a tool surface that reaches PHI (Mirth, OnBase, file
 * shares) can be held to a model the organization has a BAA for, and so
 * the admin roster shows at a glance which rows are not covered.
 */

/** What the provider keeps of a request after answering it. */
export const PROVIDER_RETENTIONS = ['none', 'abuse-monitoring', 'stored', 'unknown'] as const;
export type ProviderRetention = (typeof PROVIDER_RETENTIONS)[number];

export interface LlmDataHandling {
  /** Free text: the region / deployment the data is processed in ("Azure East US, DataZone"). */
  dataResidency: string | null;
  providerRetention: ProviderRetention;
  /** The organization holds a Business Associate Agreement covering this model. */
  baaCovered: boolean;
  notes: string | null;
}

export const DEFAULT_DATA_HANDLING: LlmDataHandling = {
  dataResidency: null,
  providerRetention: 'unknown',
  baaCovered: false,
  notes: null,
};

export function isProviderRetention(value: unknown): value is ProviderRetention {
  return typeof value === 'string' && PROVIDER_RETENTIONS.some((known) => known === value);
}

/** The data-handling fields of a model row's `settings`, defaults where absent or malformed. */
export function dataHandlingOf(settings: unknown): LlmDataHandling {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return { ...DEFAULT_DATA_HANDLING };
  }
  const row: {
    dataResidency?: unknown;
    providerRetention?: unknown;
    baaCovered?: unknown;
    notes?: unknown;
  } = settings;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  return {
    dataResidency: text(row.dataResidency),
    providerRetention: isProviderRetention(row.providerRetention)
      ? row.providerRetention
      : 'unknown',
    baaCovered: row.baaCovered === true,
    notes: text(row.notes),
  };
}

/**
 * Whether the admin roster should flag this row: no BAA, or the operator
 * has not said what the provider keeps. Enforcement (the
 * `phiConnectorsRequireCoveredModel` org setting) reads `baaCovered`
 * alone; the badge is wider so an unfilled row is noticed before it is
 * relied on.
 */
export function dataHandlingWarning(handling: LlmDataHandling): string | null {
  if (!handling.baaCovered) return 'Not BAA-covered';
  if (handling.providerRetention === 'unknown') return 'Retention unknown';
  return null;
}

/**
 * The tool namespaces that read protected health information: Mirth
 * message stores, OnBase documents, network file shares. A turn or run
 * offered any of these is one the `phiConnectorsRequireCoveredModel`
 * org setting applies to.
 */
export const PHI_CONNECTOR_TOOL_PREFIXES = ['mirth_', 'onbase_', 'fileshare_'] as const;

export function isPhiConnectorTool(name: string): boolean {
  return PHI_CONNECTOR_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Why a turn or run may not proceed on this model, or null when it may:
 * the setting is on, the tool set reaches a PHI connector, and the model's
 * configuration does not record a BAA. The message names the model so the
 * person (or the run's owner) knows which roster row to fix or which model
 * to pick instead.
 */
export function phiCoveredModelRefusal(
  required: boolean,
  toolNames: Iterable<string>,
  llm: { model: string; dataHandling?: LlmDataHandling }
): string | null {
  if (!required) return null;
  const handling = llm.dataHandling ?? DEFAULT_DATA_HANDLING;
  if (handling.baaCovered) return null;
  const reached = new Set<string>();
  for (const name of toolNames) {
    const prefix = PHI_CONNECTOR_TOOL_PREFIXES.find((candidate) => name.startsWith(candidate));
    if (prefix) reached.add(prefix.slice(0, -1));
  }
  if (reached.size === 0) return null;
  const connectors = [...reached]
    .map((key) => (key === 'onbase' ? 'OnBase' : key === 'mirth' ? 'Mirth' : 'file shares'))
    .join(', ');
  return (
    `This organization requires a BAA-covered model when ${connectors} tools are in reach, and ` +
    `"${llm.model}" is not recorded as covered. Pick a covered model, or an administrator can ` +
    'record the BAA under Agent models → Data handling.'
  );
}
