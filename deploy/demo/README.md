# The App Review demo server

`demo.atelierhq.dev` is an Atelier server for Apple's App Review of the iPhone and iPad app (a reviewer needs a server to
sign in to). It is the release's own server image with a prepared account, six formatted conversations and a placeholder
model added, running in a Cloudflare Container behind a Worker.

- **`src/index.ts`**: the Worker. Every request goes to one container (`max_instances = 1`, `basic`: 1 GiB, a quarter vCPU).
  It sleeps after 3 idle hours and wakes on the next request; its disk starts from the image each time, so the demo always
  begins as it was made (nothing a reviewer does is kept).
- **`Dockerfile`**: `FROM ghcr.io/theoriuhd/atelier:<release>` plus `build/data` (the prepared server data, copied to `/data` by
  `container/start.sh`) and `container/demo-model.mjs`.
- **`container/demo-model.mjs`**: a tiny OpenAI-compatible server on 127.0.0.1:8099. As the "Demo model" it answers every
  message with a fixed notice, so sending always works; when the data is made it answers the scripted questions instead.
- **`scripts/seed.mjs`** and **`scripts/conversations.mjs`**: run the release's own `server.mjs` on this computer, create an
  admin and the `reviewer` account through its RPC, and write the conversations by sending their questions to the demo model.
- **GPT**: a second provider, OpenAI, whose key is `${env:OPENAI_API_KEY}`: the Worker's secret, passed to the container as
  an environment variable. The key belongs to an OpenAI project made for this demo, with a spending limit and one allowed
  model, and an expiry. Nothing of it is in the data.

## Make or update it

```sh
# 1. The release's files (the version in Dockerfile and here must be the same):
cid=$(docker create --platform linux/amd64 ghcr.io/theoriuhd/atelier:v0.10.2 true)
docker cp $cid:/app/server.mjs ~/atelier-demo/server.mjs && docker cp $cid:/app/ui ~/atelier-demo/ui && docker rm $cid
# 2. The data (passwords are made and written to --creds, mode 600; the reviewer's go in the review notes):
node scripts/seed.mjs --server ~/atelier-demo/server.mjs --out build/data --creds ~/atelier-demo/creds.json
# 3. Deploy (Docker must be running; wrangler builds the image and pushes it to Cloudflare's registry):
npm install && npx wrangler deploy
# 4. The OpenAI key, from the clipboard so it is never typed or printed:
pbpaste | npx wrangler secret put OPENAI_API_KEY && pbcopy < /dev/null
```

`seed.mjs` expects the UI next to the server file (`ui/`). To bring the demo up to a newer release, repeat from step 1 with
the new tag, then change the tag in the Dockerfile.

## Take it down

`npx wrangler delete` removes the Worker and the container application; delete the OpenAI project's key and project.
