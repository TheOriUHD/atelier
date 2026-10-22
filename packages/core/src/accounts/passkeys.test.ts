import { describe, expect, it } from 'vitest';
import { openDatabase } from '../store/db.ts';
import type { AccountService } from './account-service.ts';
import { Passkeys } from './passkeys.ts';

const rp = { origin: 'https://atelier.example.com', name: 'Atelier' };
const client = { clientKind: 'web' as const, ip: '127.0.0.1', userAgent: 'test' };

describe('passkeys', () => {
  it('keeps a bounded number of open sign-ins, dropping the oldest', async () => {
    const passkeys = new Passkeys(openDatabase(':memory:'), {} as AccountService);
    const first = await passkeys.authenticationOptions(rp);
    expect(first.options).toMatchObject({ rpId: 'atelier.example.com', userVerification: 'required' });
    for (let i = 0; i < 1000; i++) await passkeys.authenticationOptions(rp);
    const response = { id: 'x', rawId: 'x', type: 'public-key', response: {}, clientExtensionResults: {} } as never;
    await expect(passkeys.signIn(first.flowId, response, rp, client)).rejects.toThrow(/expired/);
  });
});
