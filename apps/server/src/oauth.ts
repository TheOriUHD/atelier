/**
 * Connectors' OAuth sign-ins on the web (ARCHITECTURE §9-B): the browser comes back to `/oauth/callback`, and an
 * authorization server that takes client ID metadata documents reads Atelier's at `/oauth/client-metadata.json`.
 */
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { CALLBACK_HEADERS, callbackPage, CLIENT_METADATA_PATH, clientMetadata, OAUTH_CALLBACK_PATH, type Backend } from '@atelier/core';

export function oauthRoutes(app: Hono, backend: Pick<Backend, 'authenticate' | 'finishSignIn'>, { cookie, originOf }: { cookie: string; originOf(c: Context): string }): void {
  app.get(OAUTH_CALLBACK_PATH, async (c) => {
    // A sign-in started in a browser finishes only with the same person's cookie (SameSite=Lax comes along here).
    const token = getCookie(c, cookie);
    const userId = token ? ((await backend.authenticate(token))?.user.id ?? null) : null;
    const error = await backend.finishSignIn(new URL(c.req.url).searchParams, userId);
    return c.body(callbackPage(error), error ? 400 : 200, CALLBACK_HEADERS);
  });
  app.get(CLIENT_METADATA_PATH, (c) => {
    const origin = originOf(c);
    return c.json({ client_id: `${origin}${CLIENT_METADATA_PATH}`, ...clientMetadata(`${origin}${OAUTH_CALLBACK_PATH}`) });
  });
}
