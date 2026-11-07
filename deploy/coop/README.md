# Co-op relay

The relay at `coop.atelierhq.dev` lets two to four people work in one Atelier session that lives on the host's
computer. Hosts and guests are usually at home behind NAT, so everyone dials out to the relay and it forwards bytes
between them. Each guest runs its own Noise handshake with the host inside those bytes, so the relay can't read or
change what they say.

- `src/index.js`: the Worker, with a Durable Object `Room` per room (the WebSocket Hibernation API: a room with
  nothing happening leaves memory and its sockets stay open; pings are answered without waking it).
- The protocol and the room logic are in `packages/core/src/coop/relay-protocol.ts`, documented at the top of that
  file. The Worker bundles that file as it is, so the Node relay (`relay-node.ts`) and this one run the same code.

## What the relay sees and keeps

- It sees room ids, connection times, frame sizes and the callers' addresses (for the per-address limits). It never
  sees an invite's secret (it stays in the link's `#fragment`) or anything said in a room.
- It keeps, per room: the SHA-256 of the host token, when the room was made and when its host was last connected,
  and a slot counter. A room's storage is deleted when the host deletes the room, or 24 hours after the host was last
  connected.
- The host token never travels in a URL: the host sends it in the `Authorization` header of its WebSocket upgrade
  (and of a `DELETE`), and a request with a `token` parameter is refused.
- It logs nothing. Workers observability is off in `wrangler.toml`: request logs would hold callers' addresses and
  room ids, which the relay doesn't need.

## Limits

Per room (`DEFAULT_LIMITS` in relay-protocol.ts): the host and up to three guests; 4 MiB/s of data with 16 MiB of
burst, over all frames both ways (more waits in the room, up to 16 MiB, and then the sender is closed); frames of at
most 64 KiB. Per address and Cloudflare location: 30 join attempts and 10 new rooms a minute (the rate limiting
bindings in `wrangler.toml`, approximate by design). Clients ping every 20 seconds; a connection silent for a minute
is closed, so a guest who vanished frees their place.

## Deploy

From a checkout of the whole repository (the Worker bundles a file from `packages/core`):

```bash
cd deploy/coop
npx wrangler login
npx wrangler deploy      # the first deploy also applies migration v1 (the Room class, SQLite-backed)
```

- `atelierhq.dev` must be a zone in the same Cloudflare account; `wrangler deploy` creates the custom domain
  `coop.atelierhq.dev` from `routes`.
- The rate limiting `namespace_id`s (4201, 4202) must not be used by another Worker in the account.
- Check it: `curl https://coop.atelierhq.dev/` answers `Atelier co-op relay`, and
  `curl -X POST https://coop.atelierhq.dev/v1/rooms` makes a room (it expires in a day).

A later change to the `Room` class's storage needs a new `[[migrations]]` entry; renaming or deleting the class needs
`renamed_classes` or `deleted_classes`, never an edit of `v1`.

## Test

```bash
node --test deploy/coop/src/index.test.mjs       # the Worker and the Durable Object, with the runtime faked
npx vitest run packages/core/src/coop            # the room logic, the Node relay, and the clients end to end
```

## Run your own relay

- **On your Atelier server:** a self-hosted server can serve the relay itself, at `<server>/api/coop`
  (`attachCoopRelay` in `packages/core/src/coop/relay-node.ts`); clients then use that address as their relay.
- **On its own, with Node 24 or later:** `startCoopRelay({ port: 8787, host: '0.0.0.0' })` from
  `@atelier/core/coop`. Put it behind a TLS proxy (Caddy, nginx) and pass `clientIp` to read the proxy's
  `X-Forwarded-For`, or every guest counts as the proxy's address for the limits.
- **In your own Cloudflare account:** change `name` and `routes` in `wrangler.toml` to your Worker and domain, then
  deploy as above.

Everyone in a room must use the same relay: the invite link carries the room and its secret, not the relay.
