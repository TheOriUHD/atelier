import { expect, test as setup } from '@playwright/test';
import { ADMIN, ADMIN_STATE, SETUP_TOKEN, WEB_PORT } from './fixtures.ts';

setup('create the admin account and keep its sign-in', async ({ request }) => {
  const res = await request.post('/api/auth/setup', { data: { ...ADMIN, setupToken: SETUP_TOKEN } });
  expect(res.status()).toBe(200);
  await request.storageState({ path: ADMIN_STATE });
  // The specs share this account, and several pick a model: with "start with the model I used last" on, one spec's pick
  // would be the next spec's starting model. Their model is the server's, as it is for a fresh install of the suite.
  const { cookies } = await request.storageState();
  const origin = `http://127.0.0.1:${WEB_PORT}`;
  const socket = new (WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket)(`ws://127.0.0.1:${WEB_PORT}/api/ws`, {
    headers: { origin, cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
  });
  const answer = await new Promise<{ error?: unknown }>((resolve, reject) => {
    socket.onerror = () => reject(new Error('The test server refused the socket.'));
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'prefs.set', params: { path: ['models', 'rememberLast'], value: false } }));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as { id?: number; error?: unknown };
      if (message.id === 1) resolve(message);
    };
  });
  socket.close();
  expect(answer.error).toBeUndefined();
});
