import { expect, test as setup } from '@playwright/test';
import { ADMIN, ADMIN_STATE, SETUP_TOKEN } from './fixtures.ts';

setup('create the admin account and keep its sign-in', async ({ request }) => {
  const res = await request.post('/api/auth/setup', { data: { ...ADMIN, setupToken: SETUP_TOKEN } });
  expect(res.status()).toBe(200);
  await request.storageState({ path: ADMIN_STATE });
});
