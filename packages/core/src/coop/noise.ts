/**
 * Noise_XXpsk3_25519_ChaChaPoly_SHA256 (the Noise Protocol Framework, revision 34) on `node:crypto` alone: the
 * handshake co-op peers run through the relay, so the relay forwards bytes it can't read.
 *
 *   XXpsk3:
 *     -> e
 *     <- e, ee, s, es
 *     -> s, se, psk
 *
 * The initiator is the guest and the responder the host. Both sides learn the other's static key (each pins it after
 * the first join) and prove they know the invite's pre-shared key in the third message. The final handshake hash is
 * the same on both sides and feeds the emoji fingerprint (invite.ts).
 *
 * What this module leaves to its callers: transport framing, explicit nonces (`CipherState.setNonce`, spec §11.4) and
 * message sizes above Noise's 65,535 bytes (channel.ts).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from 'node:crypto';

export const PROTOCOL_NAME = 'Noise_XXpsk3_25519_ChaChaPoly_SHA256';
/** Noise's limit for any one message, handshake or transport. */
export const MAX_NOISE_MESSAGE = 65_535;
/** Poly1305's tag on every encrypted payload. */
export const TAG_LENGTH = 16;
/** X25519 keys, the pre-shared key and SHA-256 output are all this long. */
export const KEY_LENGTH = 32;

/** An X25519 key pair as raw bytes (what the app stores). */
export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export type NoiseErrorCode = 'decrypt' | 'too_large' | 'short' | 'state' | 'nonce' | 'key';

export class NoiseError extends Error {
  constructor(
    readonly code: NoiseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NoiseError';
  }
}

const EMPTY = new Uint8Array(0);
/** Noise reserves 2^64-1; JavaScript numbers stop being exact long before, so this is the ceiling here. */
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

// X25519 raw keys wrapped in the fixed DER prefixes OpenSSL wants (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function checkKey(bytes: Uint8Array, what: string): void {
  if (bytes.length !== KEY_LENGTH) throw new NoiseError('key', `${what} must be ${KEY_LENGTH} bytes, not ${bytes.length}.`);
}

function privateKeyObject(raw: Uint8Array): KeyObject {
  checkKey(raw, 'An X25519 private key');
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

function publicKeyObject(raw: Uint8Array): KeyObject {
  checkKey(raw, 'An X25519 public key');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

const rawPublic = (key: KeyObject) => new Uint8Array(key.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length));

export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return { privateKey: new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length)), publicKey: rawPublic(publicKey) };
}

/** The key pair of a stored private key. */
export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair {
  return { privateKey: new Uint8Array(privateKey), publicKey: rawPublic(createPublicKey(privateKeyObject(privateKey))) };
}

function dh(own: KeyPair, remote: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(diffieHellman({ privateKey: privateKeyObject(own.privateKey), publicKey: publicKeyObject(remote) }));
  } catch (error) {
    // OpenSSL refuses a low-order public key (the shared secret would be all zeros).
    if (error instanceof NoiseError) throw error;
    throw new NoiseError('key', 'The other side sent an unusable key.');
  }
}

const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};

const hmac = (key: Uint8Array, ...parts: Uint8Array[]) => {
  const mac = createHmac('sha256', key);
  for (const part of parts) mac.update(part);
  return new Uint8Array(mac.digest());
};

/** Noise's HKDF (spec §4.3): two or three outputs from one chaining key. */
function hkdf(chainingKey: Uint8Array, input: Uint8Array, outputs: 2): [Uint8Array, Uint8Array];
function hkdf(chainingKey: Uint8Array, input: Uint8Array, outputs: 3): [Uint8Array, Uint8Array, Uint8Array];
function hkdf(chainingKey: Uint8Array, input: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const temp = hmac(chainingKey, input);
  const first = hmac(temp, Uint8Array.of(1));
  const second = hmac(temp, first, Uint8Array.of(2));
  return outputs === 2 ? [first, second] : [first, second, hmac(temp, second, Uint8Array.of(3))];
}

/** ChaChaPoly's nonce: 32 bits of zeros, then the counter as a 64-bit little-endian number. */
function chachaNonce(n: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32LE(n % 2 ** 32, 4);
  nonce.writeUInt32LE(Math.floor(n / 2 ** 32), 8);
  return nonce;
}

/** A key and its counter (spec §5.1). Without a key it passes data through, as the handshake's first steps need. */
export class CipherState {
  #key: Uint8Array | null;
  #n = 0;

  constructor(key?: Uint8Array) {
    if (key) checkKey(key, 'A cipher key');
    this.#key = key ? new Uint8Array(key) : null;
  }

  hasKey(): boolean {
    return this.#key !== null;
  }

  /** An independent copy: the same key and nonce. */
  clone(): CipherState {
    const copy = new CipherState(this.#key ?? undefined);
    copy.#n = this.#n;
    return copy;
  }

  /** The nonce the next message uses. */
  get nonce(): number {
    return this.#n;
  }

  /** Sets the next nonce, for transport messages that carry theirs (spec §11.4: lost or dropped messages). */
  setNonce(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new NoiseError('nonce', 'That nonce is out of range.');
    this.#n = n;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.#key) return new Uint8Array(plaintext);
    if (this.#n >= MAX_NONCE) throw new NoiseError('nonce', 'This session has used all its nonces.');
    const cipher = createCipheriv('chacha20-poly1305', this.#key, chachaNonce(this.#n), { authTagLength: TAG_LENGTH });
    cipher.setAAD(ad, { plaintextLength: plaintext.length });
    const body = cipher.update(plaintext);
    cipher.final();
    const out = new Uint8Array(body.length + TAG_LENGTH);
    out.set(body);
    out.set(cipher.getAuthTag(), body.length);
    this.#n++;
    return out;
  }

  /** Throws `decrypt` for a message that wasn't made with this key, nonce and associated data; the nonce stays. */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.#key) return new Uint8Array(ciphertext);
    if (this.#n >= MAX_NONCE) throw new NoiseError('nonce', 'This session has used all its nonces.');
    if (ciphertext.length < TAG_LENGTH) throw new NoiseError('short', 'The message is too short to be encrypted.');
    const decipher = createDecipheriv('chacha20-poly1305', this.#key, chachaNonce(this.#n), { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LENGTH));
    decipher.setAAD(ad, { plaintextLength: ciphertext.length - TAG_LENGTH });
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LENGTH)), decipher.final()]);
    } catch {
      throw new NoiseError('decrypt', "The message doesn't decrypt: it was changed, or made with another key.");
    }
    this.#n++;
    return new Uint8Array(plaintext);
  }

  /** A transport message (no associated data). */
  encrypt(plaintext: Uint8Array): Uint8Array {
    return this.encryptWithAd(EMPTY, plaintext);
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    return this.decryptWithAd(EMPTY, ciphertext);
  }
}

/** The chaining key, handshake hash and current cipher (spec §5.2). */
class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  cipher = new CipherState();

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    // Longer than the hash, so it is hashed (spec §5.2, InitializeSymmetric).
    this.h = name.length <= KEY_LENGTH ? Uint8Array.from({ length: KEY_LENGTH }, (_, i) => name[i] ?? 0) : sha256(name);
    this.ck = this.h;
  }

  clone(): SymmetricState {
    const copy = new SymmetricState(PROTOCOL_NAME);
    copy.ck = new Uint8Array(this.ck);
    copy.h = new Uint8Array(this.h);
    copy.cipher = this.cipher.clone();
    return copy;
  }

  mixKey(input: Uint8Array): void {
    const [ck, key] = hkdf(this.ck, input, 2);
    this.ck = ck;
    this.cipher = new CipherState(key);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(this.h, data);
  }

  mixKeyAndHash(input: Uint8Array): void {
    const [ck, hash, key] = hkdf(this.ck, input, 3);
    this.ck = ck;
    this.mixHash(hash);
    this.cipher = new CipherState(key);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.ck, EMPTY, 2);
    return [new CipherState(first), new CipherState(second)];
  }
}

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'psk';
/** XXpsk3: message 1 from the initiator, 2 from the responder, 3 from the initiator. */
const PATTERN: Token[][] = [['e'], ['e', 'ee', 's', 'es'], ['s', 'se', 'psk']];
/** The message (by index) whose tokens include `psk`. */
const PSK_MESSAGE = 2;

export interface HandshakeOptions {
  /** The guest starts (initiator); the host answers (responder). */
  initiator: boolean;
  /** This device's long-term key. */
  staticKey: KeyPair;
  /**
   * The pre-shared key (32 bytes). XXpsk3 only uses it in message 3, so a responder that accepts several may leave it
   * out and try each on a `fork(psk)` of the handshake when message 3 arrives.
   */
  psk?: Uint8Array;
  /** Bound into the handshake hash: both sides must use the same bytes. */
  prologue?: Uint8Array;
  /** A fixed ephemeral key: for the published test vectors only. */
  ephemeral?: KeyPair;
}

/** Both directions after the handshake, from this side's point of view. */
export interface TransportState {
  send: CipherState;
  receive: CipherState;
}

/**
 * One XXpsk3 handshake (spec §5.3). Messages alternate, starting with the initiator: call `writeMessage` on your turn
 * and `readMessage` on the other's. After the third message `complete` is true and `split()` gives the transport
 * ciphers. Any failure (a wrong psk, a changed byte) throws and leaves the handshake unusable.
 */
export class HandshakeState {
  readonly initiator: boolean;
  #symmetric = new SymmetricState(PROTOCOL_NAME);
  #s: KeyPair;
  #e: KeyPair | null;
  #rs: Uint8Array | null = null;
  #re: Uint8Array | null = null;
  #psk: Uint8Array | null;
  #step = 0;
  #failed = false;

  constructor(options: HandshakeOptions) {
    if (options.psk) checkKey(options.psk, 'The pre-shared key');
    checkKey(options.staticKey.privateKey, 'The static private key');
    checkKey(options.staticKey.publicKey, 'The static public key');
    this.initiator = options.initiator;
    this.#s = options.staticKey;
    this.#e = options.ephemeral ?? null;
    this.#psk = options.psk ? new Uint8Array(options.psk) : null;
    this.#symmetric.mixHash(options.prologue ?? EMPTY);
  }

  /**
   * An independent copy of this handshake, with `psk` as its pre-shared key when given. Only before message 3 (where
   * the key is used): a responder holding several keys reads message 3 on one fork per key, and the forks that fail
   * leave this handshake as it was.
   */
  fork(psk?: Uint8Array): HandshakeState {
    if (this.#failed) throw new NoiseError('state', 'This handshake failed; start a new one.');
    if (psk && this.#step > PSK_MESSAGE) throw new NoiseError('state', 'The pre-shared key is already in this handshake.');
    if (psk) checkKey(psk, 'The pre-shared key');
    const copy = new HandshakeState({ initiator: this.initiator, staticKey: this.#s, psk: psk ?? this.#psk ?? undefined });
    copy.#symmetric = this.#symmetric.clone();
    copy.#e = this.#e;
    copy.#rs = this.#rs && new Uint8Array(this.#rs);
    copy.#re = this.#re && new Uint8Array(this.#re);
    copy.#step = this.#step;
    return copy;
  }

  /** Whether all three messages went through. */
  get complete(): boolean {
    return this.#step === PATTERN.length;
  }

  /** Whether the next call is `writeMessage` (true) or `readMessage` (false). */
  get isMyTurn(): boolean {
    return !this.complete && this.#step % 2 === (this.initiator ? 0 : 1);
  }

  /** The other side's static key, once its message carried it (the host's after message 2, the guest's after 3). */
  get remoteStatic(): Uint8Array | null {
    return this.#rs && new Uint8Array(this.#rs);
  }

  /** The handshake hash; after the last message it is the same on both sides (channel binding, the fingerprint). */
  get handshakeHash(): Uint8Array {
    return new Uint8Array(this.#symmetric.h);
  }

  #begin(write: boolean): Token[] {
    if (this.#failed) throw new NoiseError('state', 'This handshake failed; start a new one.');
    if (this.complete) throw new NoiseError('state', 'The handshake is already complete.');
    if (this.isMyTurn !== write) throw new NoiseError('state', write ? "It's the other side's turn to write." : "It's this side's turn to write.");
    return PATTERN[this.#step]!;
  }

  #needPsk(): Uint8Array {
    if (!this.#psk) throw new NoiseError('state', 'Message 3 needs a pre-shared key: give one, or `fork(psk)` first.');
    return this.#psk;
  }

  #dh(token: 'ee' | 'es' | 'se'): void {
    const sym = this.#symmetric;
    // es: the initiator's ephemeral with the responder's static; se: the other way round.
    if (token === 'ee') sym.mixKey(dh(this.#e!, this.#re!));
    else if ((token === 'es') === this.initiator) sym.mixKey(dh(this.#e!, this.#rs!));
    else sym.mixKey(dh(this.#s, this.#re!));
  }

  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    const tokens = this.#begin(true);
    const sym = this.#symmetric;
    const parts: Uint8Array[] = [];
    try {
      for (const token of tokens) {
        if (token === 'e') {
          this.#e ??= generateKeyPair();
          parts.push(this.#e.publicKey);
          sym.mixHash(this.#e.publicKey);
          // A psk handshake mixes the ephemeral into the key as well (spec §9.2).
          sym.mixKey(this.#e.publicKey);
        } else if (token === 's') parts.push(sym.encryptAndHash(this.#s.publicKey));
        else if (token === 'psk') sym.mixKeyAndHash(this.#needPsk());
        else this.#dh(token);
      }
      parts.push(sym.encryptAndHash(payload));
    } catch (error) {
      this.#failed = true;
      throw error;
    }
    const message = Buffer.concat(parts);
    if (message.length > MAX_NOISE_MESSAGE) {
      this.#failed = true;
      throw new NoiseError('too_large', `A handshake message can be at most ${MAX_NOISE_MESSAGE} bytes.`);
    }
    this.#step++;
    return new Uint8Array(message);
  }

  /** Returns the message's payload. */
  readMessage(message: Uint8Array): Uint8Array {
    const tokens = this.#begin(false);
    const sym = this.#symmetric;
    let at = 0;
    const take = (length: number) => {
      if (message.length - at < length) throw new NoiseError('short', 'The handshake message is too short.');
      at += length;
      return message.subarray(at - length, at);
    };
    try {
      if (message.length > MAX_NOISE_MESSAGE) throw new NoiseError('too_large', `A handshake message can be at most ${MAX_NOISE_MESSAGE} bytes.`);
      for (const token of tokens) {
        if (token === 'e') {
          this.#re = new Uint8Array(take(KEY_LENGTH));
          sym.mixHash(this.#re);
          sym.mixKey(this.#re);
        } else if (token === 's') this.#rs = sym.decryptAndHash(take(sym.cipher.hasKey() ? KEY_LENGTH + TAG_LENGTH : KEY_LENGTH));
        else if (token === 'psk') sym.mixKeyAndHash(this.#needPsk());
        else this.#dh(token);
      }
      const payload = sym.decryptAndHash(message.subarray(at));
      this.#step++;
      return payload;
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  /** The transport ciphers, oriented for this side: the first split cipher is initiator → responder. */
  split(): TransportState {
    if (!this.complete) throw new NoiseError('state', 'The handshake is not complete yet.');
    const [toResponder, toInitiator] = this.#symmetric.split();
    return this.initiator ? { send: toResponder, receive: toInitiator } : { send: toInitiator, receive: toResponder };
  }
}
