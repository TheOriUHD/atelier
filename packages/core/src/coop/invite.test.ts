import { describe, expect, it } from 'vitest';
import { FINGERPRINT_EMOJI, fingerprint, fingerprintNames, makeInvite, newInviteSecret, parseInvite, pskFromSecret } from './invite.ts';
import { newRoomId } from './relay-protocol.ts';

const roomId = 'AAECAwQFBgcICQoLDA0ODw';
const secret = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';

describe('co-op invites', () => {
  it('makes both links with the same fragment', () => {
    expect(makeInvite(roomId, secret)).toEqual({
      roomId,
      secret,
      fragment: `v1.${roomId}.${secret}`,
      url: `https://atelierhq.dev/join#v1.${roomId}.${secret}`,
      appUrl: `atelier://join#v1.${roomId}.${secret}`,
    });
  });

  it('round-trips a new invite through every form people paste', () => {
    const invite = makeInvite(newRoomId());
    expect(invite.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const text of [invite.url, invite.appUrl, invite.fragment, `#${invite.fragment}`, `  ${invite.url}\n`, invite.url.replace('/join#', '/join/#'), invite.url.replace('https://', 'https://www.')]) {
      expect(parseInvite(text), text).toEqual(invite);
    }
  });

  it('refuses links that are not invites', () => {
    const fragment = `v1.${roomId}.${secret}`;
    for (const text of [
      '',
      'hello',
      `https://example.com/join#${fragment}`,
      `https://atelierhq.dev/other#${fragment}`,
      `http://atelierhq.dev/join#${fragment}`,
      `v2.${roomId}.${secret}`,
      `v1.${roomId}`,
      `v1.${roomId}.${secret}.extra`,
      `v1.short.${secret}`,
      `v1.${roomId}.${secret.slice(1)}`,
      // The same bytes in another spelling (base64url's unused bits set).
      `v1.${roomId}.${secret.slice(0, -1)}_`,
      `v1.${roomId}.${secret.slice(0, -1)}+`,
    ]) {
      expect(parseInvite(text), text).toBeNull();
    }
    expect(() => makeInvite('not a room')).toThrow(TypeError);
    expect(() => makeInvite(roomId, 'short')).toThrow(TypeError);
  });

  it('derives the pre-shared key with HKDF-SHA256 and the protocol label', () => {
    const psk = pskFromSecret(secret);
    expect(psk).toHaveLength(32);
    // Fixed (checked with Python's hmac), so a change to the derivation can't slip through: both sides must agree.
    expect(Buffer.from(psk).toString('hex')).toBe('af04f38a9a8f62c784dc62a22ebca3d6d34f5a0ce256a812d42dd8a719699806');
    expect(pskFromSecret(newInviteSecret())).not.toEqual(psk);
    expect(() => pskFromSecret('nope')).toThrow(TypeError);
  });
});

describe('fingerprints', () => {
  it('chooses from 256 distinct single emoji with distinct names', () => {
    expect(FINGERPRINT_EMOJI).toHaveLength(256);
    expect(new Set(FINGERPRINT_EMOJI.map((e) => e.emoji)).size).toBe(256);
    expect(new Set(FINGERPRINT_EMOJI.map((e) => e.name.toLowerCase())).size).toBe(256);
    // One code point each, emoji by default: no variation selector to lose, nothing that renders as two.
    for (const { emoji } of FINGERPRINT_EMOJI) expect(emoji, emoji).toMatch(/^\p{Emoji_Presentation}$/u);
  });

  it('keeps the list in its order: the first and last entries stay put', () => {
    expect(FINGERPRINT_EMOJI.slice(0, 4).map((e) => e.emoji).join('')).toBe('🐶🐱🐭🐰');
    expect(FINGERPRINT_EMOJI.slice(-4).map((e) => e.emoji).join('')).toBe('👻👽🎃🧶');
  });

  it('gives the same three emoji for the same hash, and others for another', () => {
    const hash = new Uint8Array(32).map((_, i) => i);
    expect(fingerprint(hash)).toEqual(fingerprint(new Uint8Array(hash)));
    // sha256("atelier coop fingerprint v1" ‖ hash) starts 245, 81, 185.
    expect(fingerprint(hash)).toEqual(['🪑', '🌸', '🎺']);
    expect(fingerprintNames(hash)).toEqual(['chair', 'cherry blossom', 'trumpet']);
    expect(fingerprint(new Uint8Array(32))).not.toEqual(fingerprint(hash));
    expect(() => fingerprint(new Uint8Array(16))).toThrow(TypeError);
  });
});
