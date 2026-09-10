/**
 * The connectors as the admin console configures them: one definition per
 * connector_configs row (configKey), binding the catalog's metadata to the
 * form that edits that row.
 *
 * This is the only module that imports the forms. `lib/connector-catalog.ts`
 * stays pure data so chat, agents and usage can import it anywhere; this
 * file is what the admin (server) pages import — the forms are client
 * components, the definitions themselves are server data, and a
 * 'use client' here would turn the array into a client reference the page
 * could not read —  and it grows by one entry in
 * `FORMS` when a connector gains a form. A definition with no form is a
 * connector Renkei provides without credentials (cards, agents, the
 * sandbox…) or one configured elsewhere (file shares are registered one at a
 * time on their own page).
 *
 * User cards are deliberately NOT bound here: they are suite cards with
 * server-built props, wired by `suite` in `[slug]/connectors/page.tsx`.
 * Binding them by reference would be a fiction the page could not use.
 */

import type { ComponentType } from 'react';
import { CONNECTOR_CATALOG, type ConnectorEntry } from '@/lib/connector-catalog';
import {
  AtlassianForm,
  AtlassianJsmForm,
  AtlassianConfluenceForm,
  AtlassianBitbucketForm,
} from '@/app/[slug]/admin/connectors/forms/atlassian-forms';
import { WebexUserForm } from '@/app/[slug]/admin/connectors/forms/webex-user-form';
import { MicrosoftForm } from '@/app/[slug]/admin/connectors/forms/microsoft-form';
import { ZoomForm } from '@/app/[slug]/admin/connectors/forms/zoom-form';
import { OnBaseForm } from '@/app/[slug]/admin/connectors/forms/onbase-form';
import { OnBaseAdminForm } from '@/app/[slug]/admin/connectors/forms/onbase-admin-form';
import { MistralOcrForm } from '@/app/[slug]/admin/connectors/forms/mistral-ocr-form';
import { EmbeddingsForm } from '@/app/[slug]/admin/connectors/forms/embeddings-form';
import { WebSearchForm } from '@/app/[slug]/admin/connectors/forms/web-search-form';

/** Every admin form takes the same props, so the detail page can render any. */
export interface AdminFormProps {
  slug: string;
  tenantId: string;
  origin: string | null;
}

export interface ConnectorDefinition {
  /** The connector_configs row — and the admin URL segment. */
  configKey: string;
  /** What the admin list calls it; a multi-product config gets a suite name. */
  label: string;
  /** The catalog entries this config provisions (Outlook, SharePoint and OneDrive for 'microsoft'). */
  entries: ConnectorEntry[];
  /** The form editing this config's credentials and settings, when it has any. */
  adminForm?: ComponentType<AdminFormProps>;
  /** Where the connector is really managed, when not on its own page here. */
  manageHref?: (slug: string) => string;
}

/** The forms, by the configKey whose row they edit. Add a form here and it has a page. */
const FORMS: Record<string, ComponentType<AdminFormProps>> = {
  atlassian: AtlassianForm,
  'atlassian-jsm': AtlassianJsmForm,
  'atlassian-confluence': AtlassianConfluenceForm,
  'atlassian-bitbucket': AtlassianBitbucketForm,
  'webex-user': WebexUserForm,
  microsoft: MicrosoftForm,
  zoom: ZoomForm,
  onbase: OnBaseForm,
  'onbase-admin': OnBaseAdminForm,
  'mistral-ocr': MistralOcrForm,
  embeddings: EmbeddingsForm,
  'web-search': WebSearchForm,
};

/** Labels for a config row that provisions several products. */
const CONFIG_LABELS: Record<string, string> = {
  microsoft: 'Microsoft 365',
};

const MANAGE_ELSEWHERE: Record<string, (slug: string) => string> = {
  fileshares: (slug) => `/${slug}/admin/file-shares`,
};

function build(): ConnectorDefinition[] {
  const byConfig = new Map<string, ConnectorEntry[]>();
  for (const entry of CONNECTOR_CATALOG) {
    const list = byConfig.get(entry.configKey) ?? [];
    list.push(entry);
    byConfig.set(entry.configKey, list);
  }
  return [...byConfig.entries()].map(([configKey, entries]) => ({
    configKey,
    label: CONFIG_LABELS[configKey] ?? entries[0].label,
    entries,
    adminForm: FORMS[configKey],
    manageHref: MANAGE_ELSEWHERE[configKey],
  }));
}

/** One per configKey, in catalog order. */
export const CONNECTOR_DEFINITIONS: ConnectorDefinition[] = build();

export function definitionFor(configKey: string): ConnectorDefinition | undefined {
  return CONNECTOR_DEFINITIONS.find((definition) => definition.configKey === configKey);
}

/** The config keys that have a form — the ones with something to configure. */
export const CONFIGURABLE_KEYS: readonly string[] = Object.keys(FORMS);
