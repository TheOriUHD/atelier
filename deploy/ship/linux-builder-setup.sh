#!/usr/bin/env bash
# One-time setup of the Linux machine the release command uses (deploy/ship/release.mjs; Ubuntu 24.04, x86_64).
# Run it as root, once, after making the user the command logs in as (BUILDER below, key login only):
#   sudo bash linux-builder-setup.sh
# Safe to run again. Installs what a release needs: Node 24, pnpm, Go 1.27, Docker (with arm64 emulation for the server
# image), and the libraries to run the Electron and browser tests under a virtual display. It also lets Electron's
# sandbox start (Ubuntu 24.04 restricts the user namespaces it needs), so use it on a machine that only builds.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
BUILDER=builder
step() { printf '\n=== %s %s\n' "$1" "$(date +%H:%M:%S)"; }

step "disk: use the whole volume"
if lvs ubuntu-vg/ubuntu-lv >/dev/null 2>&1; then lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv || true; fi
df -h / | tail -1

step "time zone and swap"
timedatectl set-timezone UTC
if ! swapon --show | grep -q .; then
  fallocate -l 8G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
cat > /etc/sysctl.d/99-atelier-build.conf <<'EOF'
vm.swappiness = 10
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 1024
EOF
sysctl --system >/dev/null
echo 'kernel.apparmor_restrict_unprivileged_userns = 0' > /etc/sysctl.d/98-electron-userns.conf
sysctl --system >/dev/null
cat > /etc/security/limits.d/99-atelier-build.conf <<'EOF'
* soft nofile 1048576
* hard nofile 1048576
EOF

step "apt packages"
apt-get update -y
apt-get install -y --no-install-recommends \
  build-essential git curl ca-certificates gnupg unzip xz-utils zstd rsync jq python3 pkg-config fakeroot dpkg-dev \
  rpm libarchive-tools squashfs-tools desktop-file-utils libfuse2t64 \
  xvfb xauth fonts-liberation libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 libatk-bridge2.0-0t64 \
  libdrm2 libxkbcommon0 libcups2t64 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 \
  qemu-user-static binfmt-support htop tmux

step "Node 24 (official tarball, checksum verified)"
NODE_VER="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o 'node-v24[0-9.]*-linux-x64.tar.xz' | head -1 | sed 's/node-\(v[0-9.]*\)-linux.*/\1/')"
echo "node $NODE_VER"
if ! /opt/node/bin/node -v 2>/dev/null | grep -qx "$NODE_VER"; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz"
  want="$(curl -fsSL "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt" | grep "node-$NODE_VER-linux-x64.tar.xz" | cut -d' ' -f1)"
  echo "$want  $tmp/node.tar.xz" | sha256sum -c -
  rm -rf /opt/node && mkdir -p /opt/node && tar -xJf "$tmp/node.tar.xz" -C /opt/node --strip-components=1
  rm -rf "$tmp"
fi
ln -sf /opt/node/bin/node /usr/local/bin/node; ln -sf /opt/node/bin/npm /usr/local/bin/npm; ln -sf /opt/node/bin/npx /usr/local/bin/npx
ln -sf /opt/node/bin/corepack /usr/local/bin/corepack
node -v

step "pnpm (the version the repo pins)"
corepack enable
su - "$BUILDER" -c 'corepack prepare pnpm@11.22.0 --activate && pnpm -v'

step "Go 1.27 (official tarball, checksum verified)"
GO_JSON="$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all')"
GO_VER="$(echo "$GO_JSON" | jq -r '[.[] | select(.version | test("^go1\\.27(\\.|$)")) | select(.stable)][0].version')"
GO_SHA="$(echo "$GO_JSON" | jq -r --arg v "$GO_VER" '.[] | select(.version==$v) | .files[] | select(.os=="linux" and .arch=="amd64" and .kind=="archive") | .sha256')"
echo "go $GO_VER"
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q " $GO_VER "; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/go.tar.gz" "https://go.dev/dl/$GO_VER.linux-amd64.tar.gz"
  echo "$GO_SHA  $tmp/go.tar.gz" | sha256sum -c -
  rm -rf /usr/local/go && tar -C /usr/local -xzf "$tmp/go.tar.gz"
  rm -rf "$tmp"
fi
cat > /etc/profile.d/atelier-go.sh <<'EOF'
export PATH=/usr/local/go/bin:$PATH
EOF
/usr/local/go/bin/go version

step "Docker (official repository) with buildx and arm64 emulation"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker "$BUILDER"
systemctl enable --now docker
docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null 2>&1 || echo "binfmt via the image failed; qemu-user-static covers arm64 anyway"
docker --version

step "build folders"
install -d -o "$BUILDER" -g "$BUILDER" /home/$BUILDER/builds /home/$BUILDER/artifacts

step "versions"
su - "$BUILDER" -c 'export PATH=/usr/local/go/bin:$PATH; node -v; pnpm -v; go version; git --version; docker --version; nproc; free -g | sed -n 2p; df -h / | tail -1'
echo; echo "SETUP DONE"
