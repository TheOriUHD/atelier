import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));
const { connectOutcome } = await import('./connect-identity.ts');

const SERVER = 'https://atelier.example.com';

describe('connectOutcome', () => {
  it('sees the flow end on the server’s home page', () => {
    expect(connectOutcome(`${SERVER}/#/?settings=account`, SERVER)).toEqual({ status: 'connected' });
    expect(connectOutcome(`${SERVER}/`, SERVER)).toEqual({ status: 'connected' });
  });

  it('reads what went wrong from the address', () => {
    expect(connectOutcome(`${SERVER}/?signIn=identity_taken#/?settings=account`, SERVER)).toEqual({ status: 'failed', code: 'identity_taken' });
  });

  it('leaves the flow alone on its way through the provider and the callback', () => {
    expect(connectOutcome('https://auth.example.com/', SERVER)).toBeNull();
    expect(connectOutcome('https://auth.example.com/if/flow/login/', SERVER)).toBeNull();
    expect(connectOutcome(`${SERVER}/api/auth/oidc/authentik/callback?code=1&state=2`, SERVER)).toBeNull();
    expect(connectOutcome('not an address', SERVER)).toBeNull();
  });

  it('isn’t fooled by a provider with a look-alike address', () => {
    expect(connectOutcome('https://atelier.example.com.evil.test/', SERVER)).toBeNull();
    expect(connectOutcome('http://atelier.example.com/', SERVER)).toBeNull();
  });
});
