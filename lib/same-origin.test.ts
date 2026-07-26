import { describe, it, expect } from 'vitest';
import { isSameOriginRequest, isStateChanging } from './same-origin';

const SELF = 'http://localhost:3000';

describe('isStateChanging', () => {
  it('flags the mutating methods', () => {
    expect(isStateChanging('POST')).toBe(true);
    expect(isStateChanging('delete')).toBe(true);
    expect(isStateChanging('PUT')).toBe(true);
    expect(isStateChanging('PATCH')).toBe(true);
  });

  it('leaves safe methods alone', () => {
    expect(isStateChanging('GET')).toBe(false);
    expect(isStateChanging('HEAD')).toBe(false);
  });
});

describe('isSameOriginRequest', () => {
  it('allows the app calling itself', () => {
    expect(isSameOriginRequest({ secFetchSite: 'same-origin', origin: SELF }, SELF)).toBe(true);
  });

  it('rejects a cross-site page, which is the CSRF case', () => {
    expect(isSameOriginRequest({ secFetchSite: 'cross-site', origin: 'https://evil.example' }, SELF)).toBe(false);
  });

  it('rejects same-site-but-not-same-origin', () => {
    expect(isSameOriginRequest({ secFetchSite: 'same-site', origin: 'http://other.localhost:3000' }, SELF)).toBe(false);
  });

  it('rejects a direct browser navigation to a mutating route', () => {
    expect(isSameOriginRequest({ secFetchSite: 'none', origin: null }, SELF)).toBe(false);
  });

  it('falls back to Origin when Sec-Fetch-Site is absent', () => {
    expect(isSameOriginRequest({ secFetchSite: null, origin: SELF }, SELF)).toBe(true);
    expect(isSameOriginRequest({ secFetchSite: null, origin: 'https://evil.example' }, SELF)).toBe(false);
  });

  it('allows requests carrying neither header — not a browser, so not forgeable', () => {
    // curl, scripts/smoke.sh, the pytest TestClient, and the Next server's own
    // server-side proxy calls all land here. Network exposure is handled by
    // binding to loopback, not by this check.
    expect(isSameOriginRequest({ secFetchSite: null, origin: null }, SELF)).toBe(true);
  });
});
