#!/usr/bin/env bash
set -euo pipefail

REPO_ZIP_URL="https://github.com/kialajin-l/Codex-Workflow/archive/refs/heads/main.zip"
TEMP_ROOT="$(mktemp -d)"
ARCHIVE_PATH="${TEMP_ROOT}/codex-workflow.zip"

cleanup() {
  rm -rf "${TEMP_ROOT}"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

trap cleanup EXIT

require_command node
require_command npm
require_command curl
require_command unzip

echo "Downloading Codex Workflow from GitHub..."
curl -fsSL "${REPO_ZIP_URL}" -o "${ARCHIVE_PATH}"

echo "Extracting archive..."
unzip -q "${ARCHIVE_PATH}" -d "${TEMP_ROOT}"
REPO_DIR="$(find "${TEMP_ROOT}" -mindepth 1 -maxdepth 1 -type d -name 'Codex-Workflow-*' | head -n 1)"

if [[ -z "${REPO_DIR}" ]]; then
  echo "Failed to locate extracted repository directory." >&2
  exit 1
fi

cd "${REPO_DIR}"

echo "Installing npm dependencies..."
npm install
echo "Building runtime..."
npm run build
echo "Pruning dev dependencies..."
npm prune --omit=dev
echo "Installing Codex Workflow into ~/.codex ..."
node install.js

echo
echo "Install complete."
echo "Runtime: ${HOME}/.codex/codex-workflow/runtime"
echo "Wrappers: ${HOME}/.codex/codex-workflow/bin"
echo "Use shell wrapper: ${HOME}/.codex/codex-workflow/bin/cwf init"
