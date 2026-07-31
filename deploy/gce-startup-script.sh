#!/bin/bash
# GCE instance metadata startup-script. Runs once on first boot (and again on
# every reboot) to make sure Docker, Caddy, and the backend service are
# installed and enabled. Idempotent — safe to run more than once.
set -euo pipefail

# --- Docker -------------------------------------------------------------
if ! command -v docker &>/dev/null; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io
fi

# Let Docker pull from Artifact/Container Registry using the VM's own service
# account — no separate credentials file to manage.
gcloud auth configure-docker gcr.io --quiet || true

# --- Caddy ----------------------------------------------------------------
if ! command -v caddy &>/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# Deploy the checked-in Caddyfile and backend systemd unit. Adjust the source
# path if you copy these files up some other way (e.g. via a startup script
# metadata bundle, or baked into a custom VM image instead of Debian's default).
cp /opt/linkchat/deploy/Caddyfile /etc/caddy/Caddyfile
cp /opt/linkchat/deploy/linkchat-backend.service /etc/systemd/system/linkchat-backend.service

# Real secrets (MONGO_URI, REDIS_URL, JWT_SECRET, GOOGLE_CLIENT_*, GCS_*,
# ADMIN_SECRET, ...) go in /etc/linkchat-backend.env — create it out-of-band
# (e.g. `gcloud compute instances add-metadata` + a first-boot script that
# reads a secret from Secret Manager, or scp it once manually). Never bake
# secrets into this repo or the startup-script metadata field, which is
# readable by anyone with viewer access to the VM.
touch /etc/linkchat-backend.env

systemctl daemon-reload
systemctl enable --now linkchat-backend
systemctl enable --now caddy
systemctl reload caddy
