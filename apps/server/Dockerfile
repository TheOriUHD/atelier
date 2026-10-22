# The Atelier server (ARCHITECTURE §4). Build from the repository root:
#   docker build -f apps/server/Dockerfile -t atelier .
# The server bundles its dependencies, so the image holds Node, the bundle and the web app's build, plus
# the Linux runner builds and the GitHub CLI for codespaces.
# The bundle, the web build and the runner binaries don't depend on the image's architecture, so those stages run
# on the build machine's own (`--platform=$BUILDPLATFORM`): a multi-platform build doesn't emulate them. This needs
# BuildKit (Docker 23 and later builds with it; older engines: DOCKER_BUILDKIT=1).

FROM --platform=$BUILDPLATFORM golang:1.27-bookworm AS runner
ARG ATELIER_VERSION=dev
WORKDIR /src/runner
COPY runner/ ./
RUN go run ./scripts/build -version "$ATELIER_VERSION" -out /out

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@atelier/server..." --filter "@atelier/ui..." \
 && pnpm --filter @atelier/ui build \
 && pnpm --filter @atelier/server build

# Chats' sandbox (docker compose builds it with `target: sandbox`): a small Linux machine with the usual tools, reached
# by the server over SSH with its own key and nothing else. It holds no secrets and no data of the server's; chats'
# folders live in its home volume. Every account of the server gets a Unix user of its own (sbx000, sbx001, ...; 256 of
# them, ATELIER_SANDBOX_SLOTS) and a home and chat folders only that user can enter: sshd runs as root and each login
# becomes its account's user, so the operating system keeps one person's commands out of another's folders. The files are
# in apps/server/sandbox/. Nothing in the image may let a login become another user, so it has no setuid, setgid or
# file-capability program (strip-privileges.py fails the build otherwise).
FROM debian:bookworm-slim AS sandbox
LABEL org.opencontainers.image.source="https://github.com/TheOriUHD/atelier"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl wget git openssh-server openssh-client \
    python3 python3-pip python3-venv nodejs npm build-essential jq ripgrep unzip zip less file procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd /keys /home/sandbox /etc/atelier-sandbox \
 && chmod 1777 /keys
COPY --chmod=0755 apps/server/sandbox/strip-privileges.py /tmp/strip-privileges.py
RUN python3 /tmp/strip-privileges.py && rm /tmp/strip-privileges.py
COPY --chmod=0755 apps/server/sandbox/atelier-sandbox /usr/local/bin/atelier-sandbox
COPY --chmod=0755 apps/server/sandbox/atelier-sandbox-keys /usr/local/sbin/atelier-sandbox-keys
COPY --chmod=0644 apps/server/sandbox/sshd_config /etc/atelier-sandbox/sshd_config
COPY --chmod=0644 apps/server/sandbox/profile.sh /etc/profile.d/atelier-sandbox.sh
WORKDIR /home/sandbox
EXPOSE 2222
CMD ["atelier-sandbox"]

# The compose file's optional updater: it gets the Docker socket, so it is only Node, the docker CLI and one fixed script.
FROM node:24-alpine AS updater
LABEL org.opencontainers.image.source="https://github.com/TheOriUHD/atelier"
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:29-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY apps/server/src/updater/updater.ts /app/updater.ts
EXPOSE 7341
CMD ["node", "/app/updater.ts"]

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/TheOriUHD/atelier" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"
ENV NODE_ENV=production \
    ATELIER_DATA_DIR=/data \
    ATELIER_UI_DIR=/app/ui \
    ATELIER_RUNNER_DIR=/app/runner \
    ATELIER_HOST=0.0.0.0 \
    ATELIER_PORT=7340 \
    HOME=/data/home
# gh comes from GitHub's own package source: Debian's (2.23, from 2023) hangs connecting to codespaces.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system atelier \
 && useradd --system --gid atelier --home-dir /data/home atelier \
 && mkdir -p /data/home /sandbox-keys /updater \
 && chown -R atelier:atelier /data /sandbox-keys /updater \
 && chmod 1777 /sandbox-keys
WORKDIR /app
COPY --from=build /src/apps/server/dist/server.mjs ./server.mjs
COPY --from=build /src/packages/ui/dist ./ui
COPY --from=runner /out/checksums.json /out/atelier-runner-linux-* ./runner/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
# Empty in builds from source, which Settings › Admin › Server then tells to update by rebuilding.
ARG ATELIER_IMAGE=
ENV ATELIER_IMAGE=$ATELIER_IMAGE
USER atelier
VOLUME /data
EXPOSE 7340
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7340/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.mjs"]
