/**
 * Atelier's admin panel (README.md) at admin.atelierhq.dev: the inbox for issue reports and feature requests the
 * collector (deploy/reports) keeps, and the update feed's download counts (deploy/cloudflare). The page itself is the
 * SPA in apps/admin, served as static assets; this Worker answers /api/* (wrangler.toml `run_worker_first`) and runs
 * the daily cron.
 *
 * Every /api request is checked twice: Cloudflare Access in front, and the Access JWT here (access.js), failing closed.
 * Requests that change something must also carry `x-atelier-admin: 1` and a JSON content type, which a form or a link
 * on another site can't send without a CORS preflight this Worker never answers.
 */
import { verifyAccess } from './access.js';
import { fail, handle } from './api.js';
import { daily } from './cron.js';

const SAFE = new Set(['GET', 'HEAD']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/'))
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    const who = await verifyAccess(request, env);
    if (!who.ok) return fail(403, who.error);
    if (!SAFE.has(request.method)) {
      const type = request.headers.get('content-type') ?? '';
      if (request.headers.get('x-atelier-admin') !== '1' || !/^application\/json\b/i.test(type))
        return fail(403, 'Refused: this request did not come from the admin panel.');
    }
    if (!env.DB || !env.REPORTS) return fail(503, 'The admin panel has no database or bucket bound.');
    try {
      return await handle(request, env, url, who, ctx);
    } catch {
      return fail(500, 'Something went wrong on the admin Worker.');
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(daily(env));
  },
};
