import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PeakConfigError } from '@/lib/peak/crypto';

const sessionMock = vi.fn();
vi.mock('@/lib/route-helpers', () => ({
  requireSession: (...a: unknown[]) => sessionMock(...a),
}));

const { PeakAuthError, PeakUnavailableError } = vi.hoisted(() => ({
  PeakAuthError: class PeakAuthError extends Error {},
  PeakUnavailableError: class PeakUnavailableError extends Error {},
}));
const registerMock = vi.fn();
const exchangeMock = vi.fn();
const pkceMock = vi.fn();
vi.mock('@/lib/peak/oauth', () => ({
  PeakAuthError,
  PeakUnavailableError,
  registerPeakClient: (...a: unknown[]) => registerMock(...a),
  exchangeCode: (...a: unknown[]) => exchangeMock(...a),
  newPkce: (...a: unknown[]) => pkceMock(...a),
  buildAuthorizeUrl: (p: { clientId: string; challenge: string; state: string }) =>
    `https://peak.test/authorize?c=${p.clientId}&ch=${p.challenge}&s=${p.state}`,
}));

const getClientMock = vi.fn();
const saveClientMock = vi.fn();
const saveTokensMock = vi.fn();
const okMock = vi.fn();
const errMock = vi.fn();
vi.mock('@/lib/peak/token-store', () => ({
  getPeakClientId: (...a: unknown[]) => getClientMock(...a),
  savePeakClient: (...a: unknown[]) => saveClientMock(...a),
  savePeakTokens: (...a: unknown[]) => saveTokensMock(...a),
  recordPeakOk: (...a: unknown[]) => okMock(...a),
  recordPeakError: (...a: unknown[]) => errMock(...a),
}));

vi.mock('@/lib/peak/mcp-client', () => ({ createPeakClient: () => ({}) }));
const newestMock = vi.fn();
vi.mock('@/lib/peak/read', () => ({
  createPeakReader: () => ({ newestQuotations: (...a: unknown[]) => newestMock(...a) }),
}));

import { GET as connect } from '@/app/api/admin/peak/connect/route';
import { GET as callback } from '@/app/api/admin/peak/callback/route';
import { POST as testRoute } from '@/app/api/admin/peak/test/route';

const ADMIN = { user: 'nook', role: 'admin' };
const SECRET_VERIFIER = 'VERIFIER-SECRET-123';
const STATE = 'state-abc';

beforeEach(() => {
  vi.resetAllMocks();
  sessionMock.mockResolvedValue(ADMIN);
  pkceMock.mockReturnValue({ verifier: SECRET_VERIFIER, challenge: 'chal', state: STATE });
});

function loc(res: Response): string {
  return res.headers.get('location') ?? '';
}
function clearsCookie(res: Response): boolean {
  const sc = res.headers.get('set-cookie') ?? '';
  return /pp_peak_oauth=;/.test(sc) && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sc);
}
function cbReq(query: string, cookie?: string): Request {
  return new Request(`https://dashboard.penprinting.co/api/admin/peak/callback?${query}`, {
    headers: cookie ? { cookie: `pp_peak_oauth=${encodeURIComponent(cookie)}` } : {},
  });
}
const goodCookie = JSON.stringify({ state: STATE, verifier: SECRET_VERIFIER });

describe('GET /api/admin/peak/connect', () => {
  const req = () => new Request('https://dashboard.penprinting.co/api/admin/peak/connect');

  it('returns the requireSession response for non-admin', async () => {
    sessionMock.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
    const res = await connect(req());
    expect(res.status).toBe(403);
    expect(registerMock).not.toHaveBeenCalled();
  });

  it('registers a client when none exists, sets the cookie and redirects', async () => {
    getClientMock.mockResolvedValue(null);
    registerMock.mockResolvedValue({ clientId: 'cid-1' });
    const res = await connect(req());
    expect(registerMock).toHaveBeenCalledOnce();
    expect(saveClientMock).toHaveBeenCalledWith('cid-1');
    expect(res.status).toBe(302);
    expect(loc(res)).toBe('https://peak.test/authorize?c=cid-1&ch=chal&s=state-abc');
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toContain('pp_peak_oauth=');
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=lax/i);
    expect(sc).toMatch(/Path=\/api\/admin\/peak/);
    expect(sc).toMatch(/Max-Age=600/);
    const val = decodeURIComponent(/pp_peak_oauth=([^;]*)/.exec(sc)![1]);
    expect(JSON.parse(val)).toEqual({ state: STATE, verifier: SECRET_VERIFIER });
    // verifier must not leak into the redirect URL
    expect(loc(res)).not.toContain(SECRET_VERIFIER);
  });

  it('reuses an existing client', async () => {
    getClientMock.mockResolvedValue('cid-existing');
    const res = await connect(req());
    expect(registerMock).not.toHaveBeenCalled();
    expect(loc(res)).toContain('c=cid-existing');
  });

  it('redirects to /peak?error=config on PeakConfigError', async () => {
    getClientMock.mockRejectedValue(new PeakConfigError('PEAK_TOKEN_ENC_KEY is not set'));
    const res = await connect(req());
    expect(res.status).toBe(302);
    expect(new URL(loc(res)).pathname + new URL(loc(res)).search).toBe('/peak?error=config');
  });

  it('redirects to /peak?error=exchange when registration fails', async () => {
    getClientMock.mockResolvedValue(null);
    registerMock.mockRejectedValue(new PeakUnavailableError('down'));
    const res = await connect(req());
    expect(loc(res)).toMatch(/\/peak\?error=exchange$/);
  });
});

describe('GET /api/admin/peak/callback', () => {
  const path = (res: Response) => {
    const u = new URL(loc(res));
    return u.pathname + u.search;
  };

  it('non-admin gets the requireSession response', async () => {
    sessionMock.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
    const res = await callback(cbReq(`code=c&state=${STATE}`, goodCookie));
    expect(res.status).toBe(403);
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('happy path saves tokens and redirects to connected', async () => {
    getClientMock.mockResolvedValue('cid-1');
    exchangeMock.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresInSec: 3600, scope: 'mcp:read' });
    const res = await callback(cbReq(`code=THECODE&state=${STATE}`, goodCookie));
    expect(exchangeMock).toHaveBeenCalledWith({ clientId: 'cid-1', code: 'THECODE', verifier: SECRET_VERIFIER });
    expect(saveTokensMock).toHaveBeenCalledOnce();
    expect(okMock).toHaveBeenCalledOnce();
    expect(res.status).toBe(302);
    expect(path(res)).toBe('/peak?connected=1');
    expect(clearsCookie(res)).toBe(true);
    expect(loc(res)).not.toContain('THECODE');
  });

  it('state mismatch -> error=state, no exchange, cookie cleared', async () => {
    const res = await callback(cbReq('code=c&state=WRONG', goodCookie));
    expect(path(res)).toBe('/peak?error=state');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(clearsCookie(res)).toBe(true);
  });

  it('no cookie -> error=state', async () => {
    const res = await callback(cbReq(`code=c&state=${STATE}`));
    expect(path(res)).toBe('/peak?error=state');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(clearsCookie(res)).toBe(true);
  });

  it('malformed cookie -> error=state', async () => {
    const res = await callback(cbReq(`code=c&state=${STATE}`, 'not json'));
    expect(path(res)).toBe('/peak?error=state');
    expect(clearsCookie(res)).toBe(true);
  });

  it('missing code -> error=state', async () => {
    const res = await callback(cbReq(`state=${STATE}`, goodCookie));
    expect(path(res)).toBe('/peak?error=state');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(clearsCookie(res)).toBe(true);
  });

  it('error param from Peak -> error=denied', async () => {
    const res = await callback(cbReq(`error=access_denied&state=${STATE}`, goodCookie));
    expect(path(res)).toBe('/peak?error=denied');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(clearsCookie(res)).toBe(true);
  });

  it('exchange throwing PeakAuthError -> error=exchange', async () => {
    getClientMock.mockResolvedValue('cid-1');
    exchangeMock.mockRejectedValue(new PeakAuthError('rejected'));
    const res = await callback(cbReq(`code=c&state=${STATE}`, goodCookie));
    expect(path(res)).toBe('/peak?error=exchange');
    expect(saveTokensMock).not.toHaveBeenCalled();
    expect(clearsCookie(res)).toBe(true);
  });

  it('exchange throwing PeakUnavailableError -> error=exchange', async () => {
    getClientMock.mockResolvedValue('cid-1');
    exchangeMock.mockRejectedValue(new PeakUnavailableError('down'));
    const res = await callback(cbReq(`code=c&state=${STATE}`, goodCookie));
    expect(path(res)).toBe('/peak?error=exchange');
    expect(clearsCookie(res)).toBe(true);
  });

  it('PeakConfigError from savePeakTokens -> error=config', async () => {
    getClientMock.mockResolvedValue('cid-1');
    exchangeMock.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', expiresInSec: 1, scope: null });
    saveTokensMock.mockImplementation(() => {
      throw new PeakConfigError('PEAK_TOKEN_ENC_KEY is not set');
    });
    const res = await callback(cbReq(`code=c&state=${STATE}`, goodCookie));
    expect(path(res)).toBe('/peak?error=config');
    expect(okMock).not.toHaveBeenCalled();
    expect(clearsCookie(res)).toBe(true);
  });

  it('no registered client -> error=state', async () => {
    getClientMock.mockResolvedValue(null);
    const res = await callback(cbReq(`code=c&state=${STATE}`, goodCookie));
    expect(path(res)).toBe('/peak?error=state');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(clearsCookie(res)).toBe(true);
  });
});

describe('POST /api/admin/peak/test', () => {

  it('non-admin gets the requireSession response', async () => {
    sessionMock.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
    const res = await testRoute();
    expect(res.status).toBe(403);
    expect(newestMock).not.toHaveBeenCalled();
  });

  it('success returns ok + latestCode + ms and records ok', async () => {
    newestMock.mockResolvedValue([{ code: 'QO2026-0042', issuedDate: '2026-11-01', contactCode: 'C1', netAmount: 1 }]);
    const res = await testRoute();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.latestCode).toBe('QO2026-0042');
    expect(typeof body.ms).toBe('number');
    expect(okMock).toHaveBeenCalledOnce();
    const [q, n] = newestMock.mock.calls[0];
    expect(n).toBe(1);
    expect(q.dateStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('empty result is still ok with latestCode null', async () => {
    newestMock.mockResolvedValue([]);
    const body = await (await testRoute()).json();
    expect(body).toMatchObject({ ok: true, latestCode: null });
  });

  it('failure records the error and returns only the class name', async () => {
    class PeakToolError extends Error {}
    newestMock.mockRejectedValue(new PeakToolError('Bearer sekret-token leaked'));
    const res = await testRoute();
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'PeakToolError' });
    expect(text).not.toContain('sekret');
    expect(errMock).toHaveBeenCalledOnce();
    expect(String(errMock.mock.calls[0][0])).not.toContain('sekret');
  });
});
