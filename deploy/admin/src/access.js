/**
 * Who is asking, from Cloudflare Access (README.md). Access sits in front of admin.atelierhq.dev and lets only the
 * owner through; this Worker checks again on every /api request, so a mistake in the Access policy, a request that
 * reaches the Worker some other way, or a missing setting refuses everything instead of opening it:
 *
 *   - the `Cf-Access-Jwt-Assertion` header holds a JWT signed with RS256 by one of the team's keys
 *     (`https://<TEAM_DOMAIN>/cdn-cgi/access/certs`, cached here),
 *   - its `aud` includes ACCESS_AUD, its `iss` is the team domain, and it is within its `nbf`…`exp`,
 *   - its `email` is one of ADMIN_EMAILS (comma-separated).
 *
 * Local development only: DEV_NO_ACCESS = "1" lets requests through when the request's own host is localhost or
 * 127.0.0.1, which a request through Cloudflare's edge to the custom domain never is.
 */

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** How long fetched keys are trusted, and how often a token with an unknown key may make us fetch them again. */
const KEYS_FOR_MS = 10 * 60_000;
const REFETCH_AFTER_MS = 30_000;
/** Clock skew allowed on `exp` and `nbf`. */
const LEEWAY_S = 60;

const refused = (error) => ({ ok: false, error });

/** The team's signing keys by `kid`, per certs URL: `{ url → { keys: Map, at } }`. */
const cache = new Map();
/** Forgets the cached keys (tests rotate them). */
export const forgetKeys = () => cache.clear();

async function keysOf(url, { fresh = false } = {}) {
  const now = Date.now();
  const cached = cache.get(url);
  if (cached && now - cached.at < (fresh ? REFETCH_AFTER_MS : KEYS_FOR_MS)) return cached.keys;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`certs answered ${res.status}`);
  const { keys = [] } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== 'RSA' || !jwk.kid || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) continue;
    map.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    );
  }
  cache.set(url, { keys: map, at: now });
  return map;
}

const base64url = (s) =>
  Uint8Array.from(
    atob(
      s
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(s.length / 4) * 4, '='),
    ),
    (c) => c.charCodeAt(0),
  );
const decodeJson = (s) => JSON.parse(new TextDecoder().decode(base64url(s)));

/** The comma-separated ADMIN_EMAILS, lowercased. */
export const adminEmails = (value) =>
  String(value ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

/** `{ ok: true, email }` for the owner, else `{ ok: false, error }`. Never throws. */
export async function verifyAccess(request, env) {
  const host = new URL(request.url).hostname;
  if (env.DEV_NO_ACCESS === '1' && (host === 'localhost' || host === '127.0.0.1'))
    return { ok: true, email: 'dev@localhost', dev: true };

  const team = String(env.TEAM_DOMAIN ?? '')
    .trim()
    .toLowerCase();
  const audience = String(env.ACCESS_AUD ?? '').trim();
  const admins = adminEmails(env.ADMIN_EMAILS);
  if (!TEAM_DOMAIN.test(team) || !audience || admins.length === 0)
    return refused('The admin panel is not set up (TEAM_DOMAIN, ACCESS_AUD and ADMIN_EMAILS).');

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return refused('Sign in through Cloudflare Access.');
  const pieces = token.split('.');
  if (pieces.length !== 3) return refused('That sign-in is not valid.');
  let header, claims, signature;
  try {
    header = decodeJson(pieces[0]);
    claims = decodeJson(pieces[1]);
    signature = base64url(pieces[2]);
  } catch {
    return refused('That sign-in is not valid.');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return refused('That sign-in is not valid.');

  const url = `https://${team}/cdn-cgi/access/certs`;
  let key;
  try {
    key = (await keysOf(url)).get(header.kid);
    // A key we haven't seen: Access may have rotated its keys since we fetched them.
    if (!key) key = (await keysOf(url, { fresh: true })).get(header.kid);
  } catch {
    return refused("Couldn't check the sign-in (the team's keys didn't load).");
  }
  if (!key) return refused('That sign-in is not valid.');
  const signed = new TextEncoder().encode(`${pieces[0]}.${pieces[1]}`);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed)))
    return refused('That sign-in is not valid.');

  const now = Date.now() / 1000;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return refused('That sign-in is for another application.');
  if (claims.iss !== `https://${team}`) return refused('That sign-in is from another team.');
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < now)
    return refused('The sign-in expired. Reload the page.');
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S > now) return refused('That sign-in is not valid yet.');
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || !admins.includes(email)) return refused('This account may not use the admin panel.');
  return { ok: true, email };
}
