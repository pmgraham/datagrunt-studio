import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isSameOriginRequest, isStateChanging } from '@/lib/same-origin';

/**
 * Rejects cross-site mutations before they reach any /api proxy route.
 *
 * Enforced here rather than in each handler so a route added later cannot
 * forget it. The backend enforces the same rule independently, because its
 * port is reachable without going through this process at all.
 */
export function middleware(request: NextRequest) {
  if (!isStateChanging(request.method)) return NextResponse.next();

  const allowed = isSameOriginRequest(
    {
      secFetchSite: request.headers.get('sec-fetch-site'),
      origin: request.headers.get('origin'),
    },
    request.nextUrl.origin,
  );

  if (!allowed) {
    return NextResponse.json(
      { detail: 'Cross-site requests are not allowed.' },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = { matcher: '/api/:path*' };
