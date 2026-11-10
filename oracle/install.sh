#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_URL="${1:-https://github.com/ProgrammerVrushabh/ChronosMatch-Zero-Copy-High-Frequency-Trading-Engine.git}"
APP_DIR="/opt/chronosmatch"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root: sudo bash oracle/install.sh"
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl git docker.io docker-compose-plugin
systemctl enable --now docker

if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" pull --ff-only
else
  rm -rf "${APP_DIR}"
  git clone "${REPOSITORY_URL}" "${APP_DIR}"
fi

install -m 0644 "${APP_DIR}/oracle/docker-compose.yml" /opt/chronosmatch/docker-compose.yml
install -m 0644 "${APP_DIR}/oracle/chronosmatch.service" /etc/systemd/system/chronosmatch.service

if [[ ! -f "${APP_DIR}/.env.production" ]]; then
  cat > "${APP_DIR}/.env.production" <<'ENV'
FRONTEND_URL=https://infotact-project-nine.vercel.app
GEMINI_API_KEY=
ENV
  chmod 600 "${APP_DIR}/.env.production"
  echo "Created ${APP_DIR}/.env.production. Add GEMINI_API_KEY if Gemini is needed."
fi

systemctl daemon-reload
systemctl enable --now chronosmatch
echo "ChronosMatch is running. Test: curl http://$(hostname -I | awk '{print $1}')/api/engine/status"
