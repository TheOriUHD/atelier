# Self-hosting the Atelier server

The operator's guide is on the documentation site, **https://docs.atelierhq.dev/self-hosting/**, and its source is
[`apps/docs/src/content/docs/self-hosting.md`](../apps/docs/src/content/docs/self-hosting.md). It covers the compose
setup, every environment variable (also listed in
[`environment-variables.md`](../apps/docs/src/content/docs/environment-variables.md)), the chat sandbox, reverse proxies
and the `ATELIER_BASE_URL` / `ATELIER_TRUSTED_PROXIES` rules, the secrets key, updating the server (including the
optional updater service and its security), serving desktop app updates from your own server, and backups.

Quick start, for a host with Docker:

```bash
cp deploy/compose.yaml deploy/Caddyfile .   # put your hostname in both
docker compose up -d
docker compose logs atelier                 # the one-time setup token
```
