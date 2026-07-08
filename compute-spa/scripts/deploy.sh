#!/usr/bin/env bash
set -xeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SSH_TARGET="${SSH_TARGET:-root@compute.fedfork.com}"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes"

cd "$PROJECT_DIR"

# ── Build ────────────────────────────────────────────────────────────────
deno run -A build.ts

# ── Copy oauth metadata for production domain ────────────────────────────
cp oauth-client-metadata.json dist/oauth-client-metadata.json

# ── Stage on remote ──────────────────────────────────────────────────────
ssh ${SSH_OPTS} "${SSH_TARGET}" "rm -rf /tmp/stage && mkdir -p /tmp/stage"

scp ${SSH_OPTS} dist/* "${SSH_TARGET}":/tmp/stage/
scp ${SSH_OPTS} Caddyfile "${SSH_TARGET}":/tmp/stage/Caddyfile

# ── Remote setup ─────────────────────────────────────────────────────────
ssh ${SSH_OPTS} "${SSH_TARGET}" bash -xe <<'REMOTE_EOF'

# Install Caddy if absent (official Cloudsmith repo).
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# Deploy Caddyfile (before wildcard — so it's not swept into /var/www).
mv /tmp/stage/Caddyfile /etc/caddy/Caddyfile

# Deploy static files.
mkdir -p /var/www/compute-spa
rm -rf /var/www/compute-spa/*
mv /tmp/stage/* /var/www/compute-spa/
chown -R caddy:caddy /var/www/compute-spa

# Caddy systemd unit — run as root for port 80/443 bind.
cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=root
Group=root
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
LimitNPROC=512
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy
systemctl status --no-pager caddy.service

echo "Deploy complete → https://compute.fedfork.com"
REMOTE_EOF
