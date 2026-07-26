/**
 * Cross-site request rejection for the API proxy layer.
 *
 * Studio's backend has no authentication by design — it assumes a single
 * trusted local user (SECURITY.md). That assumption covers *network* callers
 * once the ports bind to loopback, but says nothing about a browser: any page
 * the user visits can make their browser POST to localhost, and the request
 * arrives with the user's own network position. This module is the trust
 * boundary for that case.
 */

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isStateChanging(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase());
}

export function isSameOriginRequest(
  headers: { secFetchSite: string | null; origin: string | null },
  selfOrigin: string | null,
): boolean {
  const { secFetchSite, origin } = headers;

  // Fetch Metadata is the precise signal, and a page cannot forge it.
  if (secFetchSite !== null) return secFetchSite === 'same-origin';

  // Older browsers: Origin is always present on a cross-origin mutation.
  if (origin !== null) return selfOrigin !== null && origin === selfOrigin;

  // Neither header: not a browser-mediated request, so there is no cross-site
  // context to forge. See the threat-model note in the plan before changing
  // this — rejecting here breaks smoke.sh and the test suites while closing
  // nothing.
  return true;
}
