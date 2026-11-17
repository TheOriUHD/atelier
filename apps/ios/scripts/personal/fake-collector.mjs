// A stand-in for the report collector (reports.atelierhq.dev), so reports.submit can be proven without sending anything anywhere.
import http from 'node:http';
const port = Number(process.argv[2] ?? 17428);
let count = 0;
http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  response.setHeader('content-type', 'application/json');
  if (request.url === '/v1/challenge') return response.end(JSON.stringify({ challenge: 'probe-challenge', bits: 0, expiresAt: Date.now() + 600_000 }));
  if (request.url === '/v1/reports') {
    count += 1;
    const parts = [...body.toString('latin1').matchAll(/name="(report|chat|shot\d)"/g)].map((m) => m[1]);
    console.log(`REPORT ${count}: ${body.length} bytes, parts ${parts.join(',')}`);
    return response.end(JSON.stringify({ id: `I-7F3K2${count}`, receivedAt: Date.now() }));
  }
  response.statusCode = 404; response.end('{}');
}).listen(port, '127.0.0.1', () => console.log(`collector on ${port}`));
