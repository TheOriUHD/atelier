import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CipherState, generateKeyPair, HandshakeState, keyPairFromPrivate, MAX_NOISE_MESSAGE, NoiseError, PROTOCOL_NAME, type KeyPair } from './noise.ts';

interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_psks: string[];
  init_static: string;
  init_ephemeral: string;
  resp_prologue: string;
  resp_psks: string[];
  resp_static: string;
  resp_ephemeral: string;
  handshake_hash: string;
  messages: { payload: string; ciphertext: string }[];
}

const { vectors } = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__/noise-vectors.json'), 'utf8')) as { vectors: Vector[] };
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const hex = (data: Uint8Array) => Buffer.from(data).toString('hex');
const text = (s: string) => new TextEncoder().encode(s);

function pair(options: { guestPsk?: Uint8Array; hostPsk?: Uint8Array; guestPrologue?: Uint8Array; hostPrologue?: Uint8Array } = {}) {
  const psk = new Uint8Array(32).fill(7);
  const guestKey = generateKeyPair();
  const hostKey = generateKeyPair();
  const guest = new HandshakeState({ initiator: true, staticKey: guestKey, psk: options.guestPsk ?? psk, prologue: options.guestPrologue });
  const host = new HandshakeState({ initiator: false, staticKey: hostKey, psk: options.hostPsk ?? psk, prologue: options.hostPrologue });
  return { guest, host, guestKey, hostKey };
}

describe('Noise_XXpsk3_25519_ChaChaPoly_SHA256', () => {
  it('has the fixture for its exact protocol name', () => {
    expect(vectors.length).toBeGreaterThan(0);
    for (const vector of vectors) expect(vector.protocol_name).toBe(PROTOCOL_NAME);
  });

  for (const [index, vector] of vectors.entries()) {
    it(`matches cacophony's vector ${index + 1}: every ciphertext, the handshake hash and the transport messages`, () => {
      const initiator = new HandshakeState({
        initiator: true,
        staticKey: keyPairFromPrivate(bytes(vector.init_static)),
        ephemeral: keyPairFromPrivate(bytes(vector.init_ephemeral)),
        psk: bytes(vector.init_psks[0]!),
        prologue: bytes(vector.init_prologue),
      });
      const responder = new HandshakeState({
        initiator: false,
        staticKey: keyPairFromPrivate(bytes(vector.resp_static)),
        ephemeral: keyPairFromPrivate(bytes(vector.resp_ephemeral)),
        psk: bytes(vector.resp_psks[0]!),
        prologue: bytes(vector.resp_prologue),
      });
      const handshake = vector.messages.slice(0, 3);
      for (const [i, message] of handshake.entries()) {
        const [writer, reader] = i % 2 === 0 ? [initiator, responder] : [responder, initiator];
        const ciphertext = writer.writeMessage(bytes(message.payload));
        expect(hex(ciphertext)).toBe(message.ciphertext);
        expect(hex(reader.readMessage(ciphertext))).toBe(message.payload);
      }
      expect(initiator.complete && responder.complete).toBe(true);
      expect(hex(initiator.handshakeHash)).toBe(vector.handshake_hash);
      expect(hex(responder.handshakeHash)).toBe(vector.handshake_hash);
      expect(hex(initiator.remoteStatic!)).toBe(hex(keyPairFromPrivate(bytes(vector.resp_static)).publicKey));
      expect(hex(responder.remoteStatic!)).toBe(hex(keyPairFromPrivate(bytes(vector.init_static)).publicKey));

      const i = initiator.split();
      const r = responder.split();
      for (const [n, message] of vector.messages.slice(3).entries()) {
        // The responder answers first after the handshake: the parties keep alternating.
        const [send, receive] = n % 2 === 0 ? [r.send, i.receive] : [i.send, r.receive];
        const ciphertext = send.encrypt(bytes(message.payload));
        expect(hex(ciphertext)).toBe(message.ciphertext);
        expect(hex(receive.decrypt(ciphertext))).toBe(message.payload);
      }
    });
  }

  it('runs a handshake both ways with fresh keys: each side learns the other static key, and the hashes agree', () => {
    const { guest, host, guestKey, hostKey } = pair();
    expect(guest.isMyTurn).toBe(true);
    expect(host.readMessage(guest.writeMessage())).toEqual(new Uint8Array(0));
    expect(guest.readMessage(host.writeMessage(text('host')))).toEqual(text('host'));
    expect(guest.remoteStatic).toEqual(hostKey.publicKey);
    expect(host.remoteStatic).toBeNull();
    expect(host.readMessage(guest.writeMessage(text('{"name":"Ada"}')))).toEqual(text('{"name":"Ada"}'));
    expect(host.remoteStatic).toEqual(guestKey.publicKey);
    expect(guest.handshakeHash).toEqual(host.handshakeHash);

    const g = guest.split();
    const h = host.split();
    expect(h.receive.decrypt(g.send.encrypt(text('to the host')))).toEqual(text('to the host'));
    expect(g.receive.decrypt(h.send.encrypt(text('to the guest')))).toEqual(text('to the guest'));
    expect(g.send.nonce).toBe(1);
  });

  it('refuses a guest with the wrong pre-shared key in the third message', () => {
    const { guest, host } = pair({ guestPsk: new Uint8Array(32).fill(8) });
    host.readMessage(guest.writeMessage());
    guest.readMessage(host.writeMessage());
    const third = guest.writeMessage(text('hello'));
    expect(() => host.readMessage(third)).toThrow(expect.objectContaining({ code: 'decrypt' }));
    // A failed handshake stays failed.
    expect(() => host.readMessage(third)).toThrow(expect.objectContaining({ code: 'state' }));
  });

  it('fails when the prologues differ', () => {
    const { guest, host } = pair({ guestPrologue: text('room a'), hostPrologue: text('room b') });
    // The first message's payload is encrypted under a key from the ephemeral, with the prologue in its hash.
    expect(() => host.readMessage(guest.writeMessage())).toThrow(NoiseError);
  });

  it('notices any changed byte in a handshake message', () => {
    for (const step of [0, 1, 2]) {
      for (const position of ['first', 'middle', 'last'] as const) {
        const { guest, host } = pair();
        const messages: (() => void)[] = [];
        let last: Uint8Array = new Uint8Array(0);
        const run = (writer: HandshakeState, reader: HandshakeState, i: number) => {
          last = writer.writeMessage(text('payload'));
          if (i === step) {
            const at = position === 'first' ? 0 : position === 'middle' ? last.length >> 1 : last.length - 1;
            last[at]! ^= 0x01;
            messages.push(() => reader.readMessage(last));
            return false;
          }
          reader.readMessage(last);
          return true;
        };
        if (run(guest, host, 0) && run(host, guest, 1)) run(guest, host, 2);
        // A changed ephemeral key in message 1 only shows when its payload fails to decrypt: so does everything else.
        expect(messages[0], `message ${step + 1}, ${position} byte`).toThrow(NoiseError);
      }
    }
  });

  it('notices a changed transport message and keeps its nonce, so the real one still decrypts', () => {
    const { guest, host } = pair();
    host.readMessage(guest.writeMessage());
    guest.readMessage(host.writeMessage());
    host.readMessage(guest.writeMessage());
    const g = guest.split();
    const h = host.split();
    const message = g.send.encrypt(text('the real message'));
    const tampered = new Uint8Array(message);
    tampered[3]! ^= 0x80;
    expect(() => h.receive.decrypt(tampered)).toThrow(expect.objectContaining({ code: 'decrypt' }));
    expect(() => h.receive.decrypt(message.subarray(0, 10))).toThrow(expect.objectContaining({ code: 'short' }));
    expect(h.receive.nonce).toBe(0);
    expect(h.receive.decrypt(message)).toEqual(text('the real message'));
    // A replayed message is refused once the nonce moved on.
    expect(() => h.receive.decrypt(message)).toThrow(expect.objectContaining({ code: 'decrypt' }));
  });

  it('decrypts a later message after lost ones when told its nonce', () => {
    const key = new Uint8Array(32).fill(3);
    const send = new CipherState(key);
    const receive = new CipherState(key);
    send.encrypt(text('lost'));
    send.encrypt(text('lost too'));
    const third = send.encrypt(text('arrives'));
    receive.setNonce(2);
    expect(receive.decrypt(third)).toEqual(text('arrives'));
    expect(receive.nonce).toBe(3);
    expect(() => receive.setNonce(-1)).toThrow(NoiseError);
  });

  it('keeps the turn order and refuses messages that are too large', () => {
    const { guest, host } = pair();
    expect(() => host.writeMessage()).toThrow(expect.objectContaining({ code: 'state' }));
    expect(() => guest.split()).toThrow(expect.objectContaining({ code: 'state' }));
    expect(() => guest.writeMessage(new Uint8Array(MAX_NOISE_MESSAGE))).toThrow(expect.objectContaining({ code: 'too_large' }));
  });

  it("refuses a low-order key instead of mixing in an all-zero secret", () => {
    const { guest, host } = pair();
    host.readMessage(guest.writeMessage());
    const second = host.writeMessage();
    // The host's ephemeral, replaced by the point at zero: `ee` would give an all-zero secret.
    second.fill(0, 0, 32);
    expect(() => guest.readMessage(second)).toThrow(expect.objectContaining({ code: 'key' }));
  });

  it('stores keys as raw bytes and derives the public key again', () => {
    const key: KeyPair = generateKeyPair();
    expect(key.privateKey).toHaveLength(32);
    expect(key.publicKey).toHaveLength(32);
    expect(keyPairFromPrivate(key.privateKey)).toEqual(key);
    expect(() => keyPairFromPrivate(new Uint8Array(31))).toThrow(expect.objectContaining({ code: 'key' }));
  });
});
