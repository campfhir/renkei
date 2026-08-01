import { NextRequest, NextResponse } from 'next/server';
import { clearOperatorCookie } from '@/lib/auth-utils';

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ success: true });
  await clearOperatorCookie(response);
  return response;
}
