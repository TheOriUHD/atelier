// A scripted OpenID Connect provider for e2e/oidc.web.spec.ts. Whoever `POST /person` named is signed in straight away:
// `/authorize` shows no page and sends the browser back with a code, as a provider does for someone already signed in.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.argv[2]);
const issuer = `http://127.0.0.1:${port}/application/o/atelier/`;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

let person = { sub: 'nobody' };
const codes = new Map();

const read = async (req) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const json = (value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  if (url.pathname === '/person') {
    person = JSON.parse(await read(req));
    return json({ ok: true });
  }
  if (url.pathname === '/application/o/atelier/.well-known/openid-configuration') {
    return json({
      issuer,
      authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
      token_endpoint: `http://127.0.0.1:${port}/token`,
      userinfo_endpoint: `http://127.0.0.1:${port}/userinfo`,
      jwks_uri: `http://127.0.0.1:${port}/jwks`,
      response_types_supported: ['code'],
    });
  }
  if (url.pathname === '/authorize') {
    const code = randomBytes(16).toString('hex');
    codes.set(code, { nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge') });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state'));
    return res.writeHead(302, { location: back.href }).end();
  }
  if (url.pathname === '/token') {
    const form = new URLSearchParams(await read(req));
    const grant = codes.get(form.get('code'));
    codes.delete(form.get('code'));
    if (!grant || grant.challenge !== createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')) return json({ error: 'invalid_grant' }, 400);
    const now = Math.floor(Date.now() / 1000);
    const token = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: issuer, sub: person.sub, aud: 'atelier-e2e', iat: now, exp: now + 60, nonce: grant.nonce })}`;
    return json({ access_token: 'access', token_type: 'Bearer', expires_in: 60, id_token: `${token}.${sign('sha256', Buffer.from(token), privateKey).toString('base64url')}` });
  }
  if (url.pathname === '/userinfo') return json(person);
  return json({ error: 'not_found' }, 404);
}).listen(port, '127.0.0.1');
