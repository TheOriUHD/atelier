/**
 * Passkeys (ARCHITECTURE §14): WebAuthn sign-in for the web. A passkey belongs to the site's hostname, so
 * the desktop app keeps signing in with passwords. The server checks the ceremonies; the browser runs them.
 */
import {
  WebAuthnError,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { appError, type PasskeySummary } from '@atelier/protocol';
import { surface } from '../../lib/platform.ts';
import { postJson, reload } from './sign-in.ts';

/** In a browser that can run WebAuthn, at a hostname (WebAuthn refuses IP addresses); never in the desktop app. */
export function passkeysAvailable(): boolean {
  return surface === 'web' && typeof window.PublicKeyCredential === 'function' && !/^[\d.]+$|^\[/.test(location.hostname);
}

/** The browser's refusals in words. Cancelling the prompt or letting it time out is the usual one. */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof WebAuthnError && e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED')
      throw appError('exists', 'This device already has a passkey for your account.');
    if (e instanceof Error && e.name === 'NotAllowedError') throw appError('cancelled', 'The passkey request was cancelled or timed out.');
    throw e;
  }
}

/** Signs in with a passkey the browser offers for this site. The page then reloads with the session cookie. */
export async function passkeySignIn(): Promise<never> {
  const { flowId, options } = (await postJson('api/auth/passkey/options', {})) as { flowId: string; options: PublicKeyCredentialRequestOptionsJSON };
  const response = await ceremony(() => startAuthentication({ optionsJSON: options }));
  await postJson('api/auth/passkey', { flowId, response });
  return reload();
}

/** Creates a passkey on this device for the signed-in person. */
export async function addPasskey(name: string): Promise<PasskeySummary> {
  const { flowId, options } = (await postJson('api/passkeys/options', {})) as { flowId: string; options: PublicKeyCredentialCreationOptionsJSON };
  const response = await ceremony(() => startRegistration({ optionsJSON: options }));
  return (await postJson('api/passkeys', { flowId, response, name })) as PasskeySummary;
}
