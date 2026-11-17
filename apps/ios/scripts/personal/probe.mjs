// node probe.mjs <user> <password> '<method>' '<json params>' ...   (repeat method/params pairs)
const [user, pass, ...rest] = process.argv.slice(2);
const socket = new WebSocket('ws://127.0.0.1:17420/api/ws');
let nextId = 1;
const call = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  const handler = ({ data }) => { const m = JSON.parse(data); if (m.id === id) { socket.removeEventListener('message', handler); resolve(m.error ? { error: m.error } : { result: m.result }); } };
  socket.addEventListener('message', handler);
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
});
await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
const login = await call('auth.login', { username: user, password: pass, clientKind: 'mobile' });
if (login.error) { console.log('LOGIN ERROR', JSON.stringify(login.error)); process.exit(1); }
for (let i = 0; i < rest.length; i += 2) {
  const out = await call(rest[i], rest[i + 1] ? JSON.parse(rest[i + 1]) : {});
  console.log('>>', rest[i], rest[i + 1] ?? '');
  console.log(JSON.stringify(out, null, 1).slice(0, 4000));
}
process.exit(0);
