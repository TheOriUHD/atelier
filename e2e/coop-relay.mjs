// The co-op relay on Node (packages/core/src/coop/relay-node.ts) on a fixed port: e2e/serve.mjs points the web server's
// ATELIER_COOP_RELAY at it, and the specs' other backends use it too (e2e/coop-relay.web.spec.ts).
// Usage: node e2e/coop-relay.mjs <port>
import { startCoopRelay } from '../packages/core/src/coop/relay-node.ts';

const relay = await startCoopRelay({ port: Number(process.argv[2] ?? 7364) });
console.log(relay.url);
const stop = () => void relay.close().finally(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
