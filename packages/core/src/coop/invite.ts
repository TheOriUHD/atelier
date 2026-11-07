/**
 * Co-op invites and fingerprints. No accounts: an invite link carries the room id and a secret, the secret only in
 * the URL fragment (browsers don't send it anywhere, and the relay never sees it). Both sides derive the Noise
 * pre-shared key from the secret, so only people with the link complete a handshake with the host.
 *
 *   https://atelierhq.dev/join#v1.<roomId>.<secret>[.<meta>]
 *   atelier://join#v1.<roomId>.<secret>[.<meta>]
 *
 * The host lets each joiner in after comparing three emoji with them (`fingerprint`, from the handshake hash both
 * sides share). After that both pin each other's device keys, and later joins need no comparing.
 */
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { fromBase64Url, isRoomId, toBase64Url } from './relay-protocol.ts';

export const INVITE_VERSION = 'v1';
export const INVITE_WEB_URL = 'https://atelierhq.dev/join';
export const INVITE_APP_URL = 'atelier://join';
/** An invite secret: 32 random bytes, base64url. */
export const INVITE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const PSK_INFO = 'atelier coop psk v1';
const FINGERPRINT_INFO = 'atelier coop fingerprint v1';

export interface Invite {
  roomId: string;
  secret: string;
  /** `v1.<roomId>.<secret>`, without the `#`. */
  fragment: string;
  /** The link to share: opens the website, which hands it to the app. */
  url: string;
  /** The same invite for the app's own scheme. */
  appUrl: string;
}

export const newInviteSecret = () => toBase64Url(randomBytes(32));

/** An invite to `roomId`, with a new secret unless one is given. */
export function makeInvite(roomId: string, secret: string = newInviteSecret()): Invite {
  if (!isRoomId(roomId)) throw new TypeError("That isn't a co-op room id.");
  if (!isSecret(secret)) throw new TypeError("That isn't a co-op invite secret.");
  const fragment = `${INVITE_VERSION}.${roomId}.${secret}`;
  return { roomId, secret, fragment, url: `${INVITE_WEB_URL}#${fragment}`, appUrl: `${INVITE_APP_URL}#${fragment}` };
}

const isSecret = (secret: string) => INVITE_SECRET_PATTERN.test(secret) && fromBase64Url(secret)?.length === 32;

/**
 * Reads an invite from either link, or from the bare fragment (with or without `#`), as people paste them: spaces
 * around it are fine. Null for anything else, including other versions.
 */
export function parseInvite(text: string): Invite | null {
  const value = text.trim();
  const hash = value.indexOf('#');
  let fragment = value;
  if (hash > 0) {
    const base = value.slice(0, hash).replace(/\/$/, '');
    if (!/^https:\/\/(www\.)?atelierhq\.dev\/join$/i.test(base) && base.toLowerCase() !== INVITE_APP_URL) return null;
    fragment = value.slice(hash + 1);
  } else if (hash === 0) fragment = value.slice(1);
  // A fourth part may follow: what the join card shows (the host's name, the title), read by `parseInviteFragment` in
  // packages/protocol/src/coop.ts. It carries nothing the channel needs.
  const [version, roomId, secret, meta, ...rest] = fragment.split('.');
  if (version !== INVITE_VERSION || rest.length || (meta !== undefined && !/^[A-Za-z0-9_-]*$/.test(meta)) || !roomId || !secret || !isRoomId(roomId) || !isSecret(secret)) return null;
  return makeInvite(roomId, secret);
}

/** The Noise pre-shared key for an invite's secret: HKDF-SHA256, no salt, info "atelier coop psk v1". */
export function pskFromSecret(secret: string): Uint8Array {
  const bytes = isSecret(secret) ? fromBase64Url(secret) : null;
  if (!bytes) throw new TypeError("That isn't a co-op invite secret.");
  return new Uint8Array(hkdfSync('sha256', bytes, new Uint8Array(0), PSK_INFO, 32));
}

/**
 * 256 emoji, each a single code point shown as emoji by default, chosen to be told apart and named easily (no
 * flags, faces, people or hands, no near-twins such as two kinds of tree). The order is part of the protocol: never
 * reorder or replace an entry, or two versions would show different emoji for the same handshake.
 */
export const FINGERPRINT_EMOJI: readonly { emoji: string; name: string }[] = (
  [
    ['🐶', 'dog'], ['🐱', 'cat'], ['🐭', 'mouse'], ['🐰', 'rabbit'], ['🦊', 'fox'], ['🐻', 'bear'], ['🐼', 'panda'], ['🐨', 'koala'],
    ['🐯', 'tiger'], ['🦁', 'lion'], ['🐮', 'cow'], ['🐷', 'pig'], ['🐸', 'frog'], ['🐵', 'monkey'], ['🐔', 'chicken'], ['🐧', 'penguin'],
    ['🦆', 'duck'], ['🦅', 'eagle'], ['🦉', 'owl'], ['🦇', 'bat'], ['🐺', 'wolf'], ['🐴', 'horse'], ['🦄', 'unicorn'], ['🐝', 'bee'],
    ['🐛', 'caterpillar'], ['🦋', 'butterfly'], ['🐌', 'snail'], ['🐞', 'ladybug'], ['🐜', 'ant'], ['🦗', 'cricket'], ['🦂', 'scorpion'], ['🐢', 'turtle'],
    ['🐍', 'snake'], ['🦎', 'lizard'], ['🦖', 'T-rex'], ['🐙', 'octopus'], ['🦑', 'squid'], ['🦐', 'shrimp'], ['🦞', 'lobster'], ['🦀', 'crab'],
    ['🐡', 'blowfish'], ['🐟', 'fish'], ['🐬', 'dolphin'], ['🐳', 'whale'], ['🦈', 'shark'], ['🐊', 'crocodile'], ['🦓', 'zebra'], ['🦍', 'gorilla'],
    ['🐘', 'elephant'], ['🦛', 'hippo'], ['🦏', 'rhino'], ['🐪', 'camel'], ['🦒', 'giraffe'], ['🦘', 'kangaroo'], ['🐑', 'sheep'], ['🐐', 'goat'],
    ['🦌', 'deer'], ['🦚', 'peacock'], ['🦜', 'parrot'], ['🦢', 'swan'], ['🦩', 'flamingo'], ['🦝', 'raccoon'], ['🦨', 'skunk'], ['🦦', 'otter'],
    ['🦥', 'sloth'], ['🦔', 'hedgehog'], ['🐉', 'dragon'], ['🦃', 'turkey'], ['🐚', 'shell'], ['🦙', 'llama'], ['🌵', 'cactus'], ['🎄', 'Christmas tree'],
    ['🌴', 'palm tree'], ['🌳', 'tree'], ['🌱', 'sprout'], ['🍀', 'clover'], ['🍁', 'maple leaf'], ['🍄', 'mushroom'], ['🌷', 'tulip'], ['🌹', 'rose'],
    ['🌻', 'sunflower'], ['🌸', 'cherry blossom'], ['💐', 'bouquet'], ['🌾', 'wheat'], ['🌍', 'globe'], ['🌙', 'moon'], ['🌞', 'sun'], ['⭐', 'star'],
    ['🌈', 'rainbow'], ['⚡', 'lightning'], ['🔥', 'fire'], ['💧', 'drop'], ['🌊', 'wave'], ['⛄', 'snowman'], ['🌋', 'volcano'], ['☔', 'umbrella'],
    ['🪐', 'planet'], ['🗻', 'mountain'], ['🍎', 'apple'], ['🍐', 'pear'], ['🍊', 'orange'], ['🍋', 'lemon'], ['🍌', 'banana'], ['🍉', 'watermelon'],
    ['🍇', 'grapes'], ['🍓', 'strawberry'], ['🍒', 'cherries'], ['🍑', 'peach'], ['🍍', 'pineapple'], ['🥥', 'coconut'], ['🥝', 'kiwi'], ['🍅', 'tomato'],
    ['🍆', 'eggplant'], ['🥑', 'avocado'], ['🥦', 'broccoli'], ['🥕', 'carrot'], ['🌽', 'corn'], ['🥒', 'cucumber'], ['🥔', 'potato'], ['🧅', 'onion'],
    ['🥜', 'peanut'], ['🌰', 'chestnut'], ['🍞', 'bread'], ['🥐', 'croissant'], ['🥨', 'pretzel'], ['🥞', 'pancakes'], ['🧇', 'waffle'], ['🧀', 'cheese'],
    ['🍗', 'drumstick'], ['🥓', 'bacon'], ['🍔', 'burger'], ['🍟', 'fries'], ['🍕', 'pizza'], ['🌭', 'hot dog'], ['🥪', 'sandwich'], ['🌮', 'taco'],
    ['🌯', 'burrito'], ['🥚', 'egg'], ['🍳', 'frying pan'], ['🍿', 'popcorn'], ['🧂', 'salt'], ['🍣', 'sushi'], ['🍙', 'rice ball'], ['🍜', 'ramen'],
    ['🍝', 'spaghetti'], ['🥟', 'dumpling'], ['🍦', 'ice cream'], ['🍩', 'doughnut'], ['🍪', 'cookie'], ['🎂', 'cake'], ['🧁', 'cupcake'], ['🥧', 'pie'],
    ['🍫', 'chocolate'], ['🍬', 'candy'], ['🍭', 'lollipop'], ['🍯', 'honey'], ['☕', 'coffee'], ['🍵', 'tea'], ['🥤', 'soda'], ['🍺', 'beer'],
    ['🍷', 'wine'], ['🍸', 'cocktail'], ['🧊', 'ice cube'], ['🥄', 'spoon'], ['🍴', 'knife and fork'], ['⚽', 'football'], ['🏀', 'basketball'], ['⚾', 'baseball'],
    ['🎾', 'tennis ball'], ['🎱', 'pool ball'], ['🏓', 'ping pong'], ['🥊', 'boxing glove'], ['🎳', 'bowling'], ['⛳', 'golf flag'], ['🎣', 'fishing rod'], ['🛹', 'skateboard'],
    ['🎿', 'skis'], ['🏆', 'trophy'], ['🥇', 'gold medal'], ['🎯', 'target'], ['🎲', 'dice'], ['🧩', 'puzzle piece'], ['🎮', 'game controller'], ['🎸', 'guitar'],
    ['🎹', 'piano'], ['🎺', 'trumpet'], ['🎻', 'violin'], ['🥁', 'drum'], ['🎷', 'saxophone'], ['🎤', 'microphone'], ['🎧', 'headphones'], ['🎨', 'paint palette'],
    ['🎭', 'theater masks'], ['🎈', 'balloon'], ['🎁', 'gift'], ['🎉', 'party popper'], ['🪁', 'kite'], ['🧸', 'teddy bear'], ['🪀', 'yo-yo'], ['🔔', 'bell'],
    ['🔑', 'key'], ['🔒', 'padlock'], ['🔨', 'hammer'], ['🪓', 'axe'], ['🔧', 'wrench'], ['🧲', 'magnet'], ['🧭', 'compass'], ['🔭', 'telescope'],
    ['💡', 'light bulb'], ['🔦', 'flashlight'], ['📚', 'books'], ['📎', 'paperclip'], ['📌', 'pushpin'], ['📦', 'parcel'], ['📷', 'camera'], ['📺', 'television'],
    ['📻', 'radio'], ['⏰', 'alarm clock'], ['⌛', 'hourglass'], ['💎', 'gem'], ['👑', 'crown'], ['🎩', 'top hat'], ['👓', 'glasses'], ['🧦', 'socks'],
    ['👟', 'sneaker'], ['🧢', 'cap'], ['🎒', 'backpack'], ['🧣', 'scarf'], ['🧤', 'gloves'], ['💍', 'ring'], ['🚀', 'rocket'], ['🚲', 'bicycle'],
    ['🚗', 'car'], ['🚂', 'train'], ['⛵', 'sailboat'], ['🚁', 'helicopter'], ['🛸', 'flying saucer'], ['🚌', 'bus'], ['🚜', 'tractor'], ['🏠', 'house'],
    ['🏰', 'castle'], ['⛺', 'tent'], ['🎡', 'ferris wheel'], ['⚓', 'anchor'], ['🧱', 'brick'], ['🪑', 'chair'], ['🛁', 'bathtub'], ['🚪', 'door'],
    ['🧹', 'broom'], ['🧺', 'basket'], ['🎀', 'ribbon'], ['🤖', 'robot'], ['👻', 'ghost'], ['👽', 'alien'], ['🎃', 'pumpkin'], ['🧶', 'yarn'],
  ] as const
).map(([emoji, name]) => ({ emoji, name }));

function fingerprintIndexes(handshakeHash: Uint8Array): [number, number, number] {
  if (handshakeHash.length !== 32) throw new TypeError('A handshake hash is 32 bytes.');
  const digest = createHash('sha256').update(FINGERPRINT_INFO).update(handshakeHash).digest();
  return [digest[0]!, digest[1]!, digest[2]!];
}

/** Three emoji both sides of a handshake show, so the host and the joiner can compare them (24 bits). */
export function fingerprint(handshakeHash: Uint8Array): [string, string, string] {
  const [a, b, c] = fingerprintIndexes(handshakeHash);
  return [FINGERPRINT_EMOJI[a]!.emoji, FINGERPRINT_EMOJI[b]!.emoji, FINGERPRINT_EMOJI[c]!.emoji];
}

/** The same three as words, for reading out and for screen readers. */
export function fingerprintNames(handshakeHash: Uint8Array): [string, string, string] {
  const [a, b, c] = fingerprintIndexes(handshakeHash);
  return [FINGERPRINT_EMOJI[a]!.name, FINGERPRINT_EMOJI[b]!.name, FINGERPRINT_EMOJI[c]!.name];
}
