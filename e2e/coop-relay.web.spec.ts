import { rm } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { contract, createMemoryTransportPair, createRpcClient, type AppContract, type RpcClient } from '../packages/protocol/src/index.ts';
import { createBackend, type Backend } from '../packages/core/src/backend/backend.ts';
import { COOP_RELAY_URL, tempConfigDir } from './fixtures.ts';

/**
 * Co-op between the Atelier server (the browser, signed in to it) and another computer, through the relay e2e/serve.mjs
 * starts. The other computer is a desktop backend run here, its person Ben driven through the app contract as his app
 * would; its models are the same fake Ollama's.
 */

let other: Backend | null = null;
let dir: string | null = null;

test.afterEach(async () => {
  await other?.dispose().catch(() => undefined);
  other = null;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

/** A desktop on "another computer", with Ben set up on it. */
async function otherComputer(): Promise<RpcClient<AppContract>> {
  dir = await tempConfigDir({ profile: { name: 'Ben' } });
  other = await createBackend({
    surface: 'desktop',
    configDir: dir,
    dataDir: dir,
    cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
    env: { ATELIER_COOP_RELAY: COOP_RELAY_URL },
    logger: { info: () => {}, error: () => {} },
  });
  const [clientSide, serverSide] = createMemoryTransportPair();
  other.connect(serverSide, { client: { clientKind: 'desktop', ip: '127.0.0.1', userAgent: 'e2e' } });
  const ben = createRpcClient(contract, clientSide);
  await ben.call('auth.setup', { username: 'ben', name: 'Ben', password: 'ben-password', clientKind: 'desktop' });
  return ben;
}

const texts = async (ben: RpcClient<AppContract>, id: string) => (await ben.call('sessions.subscribe', { id })).messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])));

async function send(page: Page, text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
}

test('in the browser on the server, join a session on another computer from its invite link', async ({ page }) => {
  test.setTimeout(180_000);
  const ben = await otherComputer();
  // Ben's chat on his computer, with one exchange, and an invite link for it.
  const session = await ben.call('sessions.create', { mode: 'chat' });
  await ben.call('sessions.update', { id: session.id, title: 'Shader plan' });
  await ben.call('chat.send', { sessionId: session.id, parts: [{ type: 'text', text: 'the shader plan' }] });
  await expect.poll(() => texts(ben, session.id), { timeout: 30_000 }).toContain('You said: the shader plan');
  await ben.call('coop.start', { sessionId: session.id });
  const { url } = await ben.call('coop.invite', { sessionId: session.id });

  // Tester pastes it into Atelier in the browser: More › Join a co-op session…
  await page.goto('/');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Join a co-op session…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Join a co-op session' });
  await dialog.getByRole('textbox').fill(url);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Join Ben’s session Shader plan?');
  await expect(page.getByText('It runs on Ben’s computer.')).toBeVisible();
  await page.getByRole('button', { name: 'Join', exact: true }).click();

  // Ben sees the knock with the same four emoji Tester sees, and lets them in.
  await expect(page.getByRole('heading', { name: 'Waiting for Ben to let you in…' })).toBeVisible({ timeout: 30_000 });
  const shown = (await page.getByLabel(/^Fingerprint:/).getAttribute('aria-label'))!.replace('Fingerprint: ', '');
  await expect.poll(async () => (await ben.call('coop.state', { sessionId: session.id }))?.knocking.length ?? 0, { timeout: 30_000 }).toBe(1);
  const [knock] = (await ben.call('coop.state', { sessionId: session.id }))!.knocking;
  expect(knock).toMatchObject({ name: 'Tester' });
  expect(knock!.fingerprint.join(' ')).toBe(shown);
  await ben.call('coop.admit', { sessionId: session.id, knockId: knock!.id, allow: true });

  // In: the conversation so far, in the sidebar too, and Tester's message answered in Ben's session as theirs.
  await expect(page.getByText('You said: the shader plan', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: /Shader plan/ })).toBeVisible();
  await send(page, 'calmer waves');
  await expect(page.getByText('You said: calmer waves', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => texts(ben, session.id), { timeout: 30_000 }).toContain('calmer waves');
  const people = (await ben.call('coop.state', { sessionId: session.id }))!.participants;
  expect(people.map((p) => [p.name, p.kind])).toEqual([
    ['Ben', 'account'],
    ['Tester', 'peer'],
  ]);

  // Tester leaves and keeps a copy on the server.
  await page.getByRole('button', { name: /^Co-op:/ }).click();
  await page.getByRole('dialog', { name: 'Co-op' }).getByRole('button', { name: 'Leave' }).click();
  await page.getByRole('alertdialog', { name: 'Leave Ben’s session?' }).getByRole('button', { name: 'Leave' }).click();
  await expect(page.getByRole('navigation', { name: 'Sidebar' }).getByRole('link', { name: /Shader plan \(co-op\)/ })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await ben.call('coop.state', { sessionId: session.id }))?.participants.length, { timeout: 30_000 }).toBe(1);
});

test('a session on the server: its invite link is joined from another computer, the host lets them in and they write in it', async ({ page, context }) => {
  test.setTimeout(180_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const ben = await otherComputer();

  await page.goto('/');
  await send(page, 'hello from the host');
  await expect(page.getByText('You said: hello from the host', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/chat\//);

  // Co-op on the server, and a link for someone elsewhere, in one click.
  await page.getByRole('button', { name: 'Co-op', exact: true }).click();
  const popover = page.getByRole('dialog', { name: 'Co-op' });
  await expect(popover.getByText(/teammates on this server, or anyone you send a link to/)).toBeVisible();
  await popover.getByRole('button', { name: 'Copy invite link' }).click();
  await expect(page.getByText('Invite link copied')).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toMatch(/^https:\/\/atelierhq\.dev\/join#v1\./);
  await expect(popover.getByText('On this server')).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Invite a teammate' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Ben, on his computer, joins: Tester hears the knock wherever they are, and compares the emoji.
  const joined = await ben.call('coop.join', { invite: url, models: 'host' });
  expect(joined.waiting).toBe(true);
  await expect(page.getByText('Ben wants to join').first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^Co-op/ }).first().click();
  const card = page.getByRole('dialog', { name: 'Co-op' }).getByRole('region', { name: 'Ben wants to join' });
  await expect(card.getByLabel(`Fingerprint: ${joined.fingerprint!.join(' ')}`)).toBeVisible();
  await card.getByRole('button', { name: 'Let in' }).click();
  await expect.poll(async () => (await ben.call('coop.state', { sessionId: joined.sessionId }).catch(() => null)) !== null, { timeout: 30_000 }).toBe(true);
  expect(await ben.call('coop.state', { sessionId: joined.sessionId })).toMatchObject({ hostedOn: 'server', via: 'relay' });
  await page.keyboard.press('Escape');

  // Ben writes, as the app does in a shared session: Tester sees it under his name, answered in the session.
  expect(await texts(ben, joined.sessionId)).toContain('hello from the host');
  await ben.call('chat.queue', { sessionId: joined.sessionId, parts: [{ type: 'text', text: 'calmer waves from Ben' }] });
  await expect(page.getByText('You said: calmer waves from Ben', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Ben', { exact: true }).first()).toBeVisible();
  await expect.poll(() => texts(ben, joined.sessionId), { timeout: 30_000 }).toContain('You said: calmer waves from Ben');

  // Tester ends co-op: Ben keeps a copy on his computer.
  await page.getByRole('button', { name: /^Co-op:/ }).click();
  await page.getByRole('dialog', { name: 'Co-op' }).getByRole('button', { name: 'End co-op' }).click();
  await page.getByRole('alertdialog', { name: 'End co-op?' }).getByRole('button', { name: 'End co-op' }).click();
  await expect.poll(async () => (await ben.call('sessions.list', {})).some((s) => s.title.endsWith('(co-op)')), { timeout: 30_000 }).toBe(true);
});
