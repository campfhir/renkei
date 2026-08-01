import type { ReactNode } from 'react';
import { LogsClientApp } from './logs-client-app.js';
import type { ConsoleContext } from './pages.js';

interface LogsPanelProps {
  context: ConsoleContext;
}

export function LogsPanel({ context }: LogsPanelProps): ReactNode {
  return <LogsClientApp tenantSlug={context.tenant.slug} />;
}
