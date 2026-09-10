'use client';

import {
  AtlassianForm,
  AtlassianJsmForm,
  AtlassianConfluenceForm,
  AtlassianBitbucketForm,
} from './forms/atlassian-forms';
import { WebexUserForm } from './forms/webex-user-form';
import { MicrosoftForm } from './forms/microsoft-form';
import { ZoomForm } from './forms/zoom-form';
import { OnBaseForm } from './forms/onbase-form';
import { OnBaseAdminForm } from './forms/onbase-admin-form';
import { MistralOcrForm } from './forms/mistral-ocr-form';
import { EmbeddingsForm } from './forms/embeddings-form';
import { WebSearchForm } from './forms/web-search-form';

export default function ConnectorForms({
  slug,
  tenantId,
  origin,
}: {
  slug: string;
  tenantId: string;
  origin: string | null;
}) {
  return (
    <div className="space-y-6">
      <AtlassianForm slug={slug} origin={origin} />
      <AtlassianJsmForm slug={slug} origin={origin} />
      <AtlassianConfluenceForm slug={slug} origin={origin} />
      <AtlassianBitbucketForm slug={slug} origin={origin} />
      <WebexUserForm slug={slug} origin={origin} />
      <MicrosoftForm slug={slug} origin={origin} />
      <ZoomForm slug={slug} tenantId={tenantId} origin={origin} />
      <OnBaseForm slug={slug} origin={origin} />
      <OnBaseAdminForm slug={slug} origin={origin} />
      <MistralOcrForm slug={slug} />
      <EmbeddingsForm slug={slug} />
      <WebSearchForm slug={slug} />
    </div>
  );
}
