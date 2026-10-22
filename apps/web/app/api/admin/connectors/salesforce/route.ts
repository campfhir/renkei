/** The Salesforce CRM connectors (one per org): lib/salesforce-connectors-admin.ts. */

import { salesforceConnectorsRoute } from '@/lib/salesforce-connectors-admin';
import { SALESFORCE_CRM_KIND } from '@/lib/salesforce-kinds';

export const { GET, PUT, DELETE } = salesforceConnectorsRoute(SALESFORCE_CRM_KIND);
