/**
 * Signing in with an identity provider (ARCHITECTURE §21). The sign-in page asks for the provider's address and sends
 * the browser there; it comes back to `<OIDC_PATH>/<id>/callback`, which signs it in like a password would, or back to
 * the page with `?signIn=<code>` saying what went wrong.
 */
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { AccountError, type Backend, type ClientInfo } from '@atelier/core';
import { OIDC_PATH } from '@atelier/protocol';

/** Long enough to sign in at the provider, MFA included; the flow itself ends at the same time. */
const FLOW_MAX_AGE_S = 10 * 60;

export interface OidcRouteOptions {
  cookie: string;
  originOf(c: Context): string;
  sameOrigin(c: Context): boolean;
  secure(c: Context): boolean;
  clientOf(c: Context): ClientInfo;
  keepSignIn(c: Context, token: string): void;
}

export function oidcRoutes(app: Hono, backend: Pick<Backend, 'authenticate' | 'oidc'>, { cookie, originOf, sameOrigin, secure, clientOf, keepSignIn }: OidcRouteOptions): void {
  const flowCookie = `${cookie}_oidc`;
  const signedIn = async (c: Context) => {
    const token = getCookie(c, cookie);
    return token ? ((await backend.authenticate(token))?.user.id ?? null) : null;
  };

  app.post(`${OIDC_PATH}/:id/start`, async (c) => {
    if (!sameOrigin(c)) return c.json({ code: 'bad_origin', message: 'Cross-site request refused.' }, 403);
    const { link } = z.object({ link: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
    const userId = link ? await signedIn(c) : null;
    if (link && !userId) return c.json({ code: 'unauthenticated', message: 'Sign in first.' }, 401);
    const id = c.req.param('id');
    try {
      const { flowId, url } = await backend.oidc.begin(id, `${originOf(c)}${OIDC_PATH}/${id}/callback`, userId);
      setCookie(c, flowCookie, flowId, { httpOnly: true, sameSite: 'Lax', secure: secure(c), path: OIDC_PATH, maxAge: FLOW_MAX_AGE_S });
      return c.json({ url });
    } catch (e) {
      if (e instanceof AccountError) return c.json({ code: e.code, message: e.message }, 400);
      throw e;
    }
  });

  app.get(`${OIDC_PATH}/:id/callback`, async (c) => {
    const flowId = getCookie(c, flowCookie) ?? '';
    deleteCookie(c, flowCookie, { path: OIDC_PATH });
    const userId = await signedIn(c);
    // Someone signed in was connecting a provider: their settings are where they left.
    const back = userId ? '#/?settings=account' : '';
    try {
      const result = await backend.oidc.finish(c.req.param('id'), flowId, new URL(c.req.url).search, userId, clientOf(c));
      if ('signedIn' in result) keepSignIn(c, result.signedIn.token);
      return c.redirect(`/${back}`);
    } catch (e) {
      if (e instanceof AccountError) return c.redirect(`/?signIn=${e.code}${back}`);
      throw e;
    }
  });
}
