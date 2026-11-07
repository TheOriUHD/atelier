/**
 * Co-op's transport (`@atelier/core/coop`): invites and fingerprints, the host's room and a guest's channel through
 * the relay, end-to-end encrypted with Noise; and the relay itself on Node, for servers that host their own.
 */
export {
  CHUNK_BYTES,
  CoopError,
  createRoom,
  decodeKey,
  DEFAULT_COOP_RELAY,
  DEFAULT_TIMING,
  deleteRoom,
  encodeKey,
  generateStaticKey,
  GuestChannel,
  HostRoom,
  joinRoom,
  MAX_HANDSHAKES_PER_MINUTE,
  MAX_HELLO_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_PSKS,
  openHostRoom,
  parseStaticKey,
  serializeStaticKey,
  type CoopCloseReason,
  type CoopErrorCode,
  type CoopHello,
  type CoopTiming,
  type HostRoomOptions,
  type JoinRoomOptions,
  type PeerChannel,
  type RelayState,
  type StaticKey,
} from './channel.ts';
export { FINGERPRINT_EMOJI, fingerprint, fingerprintNames, INVITE_APP_URL, INVITE_WEB_URL, makeInvite, newInviteSecret, parseInvite, pskFromSecret, type Invite } from './invite.ts';
export { attachCoopRelay, createCoopRelay, startCoopRelay, type CoopRelay, type CoopRelayOptions, type StandaloneCoopRelay } from './relay-node.ts';
export { CloseCode, DEFAULT_LIMITS, type RelayLimits } from './relay-protocol.ts';
