/** The Salesforce CRM connectors (one per org): lib/salesforce-connectors-admin.ts. */

import { salesforceConnectorsRoute } from '@/lib/salesforce-connectors-admin';
import { SALESFORCE_CRM_KIND } from '@/lib/salesforce-kinds';
import { routeLog } from '@/lib/log-context';

const salesforceRoute = salesforceConnectorsRoute(SALESFORCE_CRM_KIND);
export const GET = routeLog(salesforceRoute.GET);
export const PUT = routeLog(salesforceRoute.PUT);
export const DELETE = routeLog(salesforceRoute.DELETE);
