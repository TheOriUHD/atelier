/**
 * The relay and the encrypted channel (channel.ts, invite.ts) as the host and the guest gateway use them: rooms opened
 * with this computer's device key, and the invite's secret turned into the Noise pre-shared key.
 */
import { createRoom, deleteRoom, joinRoom, openHostRoom, type GuestChannel, type PeerChannel, type StaticKey } from './channel.ts';
import type { GuestTransportPort, GuestChannelPort } from './gateway.ts';
import type { CoopTransportPort, HostRoomPort, PeerChannelPort } from './host.ts';
import { newInviteSecret, pskFromSecret } from './invite.ts';

const peerPort = (peer: PeerChannel): PeerChannelPort => ({
  remoteKey: peer.remoteKey,
  pskIndex: peer.pskIndex,
  fingerprint: [...peer.fingerprint],
  send: (message) => peer.send(message),
  onMessage: (handler) => peer.onMessage(handler),
  onClose: (handler) => peer.onClose(() => handler()),
  close: () => peer.close(),
});

const guestPort = (channel: GuestChannel): GuestChannelPort => ({
  get remoteKey() {
    return channel.remoteKey;
  },
  get fingerprint() {
    return [...channel.fingerprint];
  },
  send: (message) => channel.send(message),
  onMessage: (handler) => channel.onMessage(handler),
  onClose: (handler) => channel.onClose(() => handler()),
  onReconnected: (handler) => void channel.on('reconnected', handler),
  onHost: (handler) => void channel.on('host', handler),
  setSecret: (secret) => channel.setPsk(pskFromSecret(secret)),
  close: () => channel.close(),
});

export function relayTransport(deviceKey: () => Promise<StaticKey>): CoopTransportPort & GuestTransportPort {
  return {
    createRoom: (relayUrl) => createRoom(relayUrl),
    deleteRoom: (relayUrl, roomId, hostToken) => deleteRoom(relayUrl, roomId, hostToken),
    newSecret: () => newInviteSecret(),
    async openHostRoom({ relayUrl, roomId, hostToken, secrets }): Promise<HostRoomPort> {
      const room = await openHostRoom({ relayUrl, roomId, hostToken, psks: secrets.map(pskFromSecret), staticKey: await deviceKey() });
      return {
        onPeer: (handler) => void room.on('peer', (peer) => handler(peerPort(peer))),
        setSecrets: (list) => room.setPsks(list.map(pskFromSecret)),
        onRelayState: (handler) => void room.on('relay-state', handler),
        close: async () => room.close(),
      };
    },
    async join({ relayUrl, roomId, secret, name, version, hostKey, signal }) {
      const channel = await joinRoom({
        relayUrl,
        roomId,
        psk: pskFromSecret(secret),
        staticKey: await deviceKey(),
        hello: { name, version },
        ...(hostKey ? { hostKey } : {}),
        ...(signal ? { signal } : {}),
      });
      return guestPort(channel);
    },
  };
}
