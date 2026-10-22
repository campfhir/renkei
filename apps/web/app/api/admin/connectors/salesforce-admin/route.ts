/** The Salesforce admin connectors (one per org): lib/salesforce-connectors-admin.ts. */

import { salesforceConnectorsRoute } from '@/lib/salesforce-connectors-admin';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';

export const { GET, PUT, DELETE } = salesforceConnectorsRoute(SALESFORCE_ADMIN_KIND);
