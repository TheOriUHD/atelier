// The App Review demo server (README.md): every request goes to one Atelier server running in a Cloudflare Container. The
// container wakes on the first request, starts from the image's disk (so the demo always begins as it was made) and goes to
// sleep after a few idle hours, which is what keeps it cheap.
import { Container, getContainer } from '@cloudflare/containers';
import type { DurableObject } from 'cloudflare:workers';

interface Env {
  ATELIER_DEMO: DurableObjectNamespace<AtelierDemo>;
  /** A secret (`wrangler secret put OPENAI_API_KEY`): the key of an OpenAI project made for this demo alone. */
  OPENAI_API_KEY?: string;
}

/** Change this with anything the container's environment (below) depends on: the first request after a deploy that changes it
 * restarts the container. A running container keeps the environment it started with, and Cloudflare keeps it running across
 * deploys until it has been idle for `sleepAfter`. */
const ENVIRONMENT_REVISION = '5';

export class AtelierDemo extends Container<Env> {
  defaultPort = 7340;
  requiredPorts = [7340];
  // Open sockets and requests keep it awake; this is how long it stays up with none.
  sleepAfter = '3h';
  // The server reaches OpenAI's API from inside.
  enableInternet = true;

  constructor(ctx: DurableObject['ctx'], env: Env) {
    super(ctx, env);
    this.envVars = {
      // What the server believes its address is. Without it a browser's `Origin` (demo.atelierhq.dev) never matches the
      // container's own address and sign-in and the live connection are refused; the phone app sends no Origin, which is why
      // it worked without.
      ATELIER_BASE_URL: 'https://demo.atelierhq.dev',
      // Read by the server when a request goes out (the provider's key is `${env:OPENAI_API_KEY}`); never stored in the data.
      ...(env.OPENAI_API_KEY ? { OPENAI_API_KEY: env.OPENAI_API_KEY } : {}),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    if ((await this.ctx.storage.get('environment-revision')) !== ENVIRONMENT_REVISION) {
      // Noted first, so requests arriving meanwhile don't each stop it again.
      await this.ctx.storage.put('environment-revision', ENVIRONMENT_REVISION);
      await this.destroy().catch(() => undefined);
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.ATELIER_DEMO, 'demo').fetch(request);
  },
};
