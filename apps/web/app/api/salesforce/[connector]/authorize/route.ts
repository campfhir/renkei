/** Connect to one salesforce connector (org): lib/salesforce-connect-authorize.ts. */

import type { NextRequest } from 'next/server';
import { authorizeSalesforce } from '@/lib/salesforce-connect-authorize';
import { SALESFORCE_CRM_KIND } from '@/lib/salesforce-kinds';

export function GET(request: NextRequest, context: { params: Promise<{ connector: string }> }) {
  return authorizeSalesforce(SALESFORCE_CRM_KIND, request, context);
}
