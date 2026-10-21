/** Connect to one salesforce-admin connector (org): lib/salesforce-connect-authorize.ts. */

import type { NextRequest } from 'next/server';
import { authorizeSalesforce } from '@/lib/salesforce-connect-authorize';
import { SALESFORCE_ADMIN_KIND } from '@/lib/salesforce-kinds';

export function GET(request: NextRequest, context: { params: Promise<{ connector: string }> }) {
  return authorizeSalesforce(SALESFORCE_ADMIN_KIND, request, context);
}
