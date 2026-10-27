#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?Repository absolute path is required}"
node_bin="${2:?Node.js executable absolute path is required}"
case "$repo_root" in /*) ;; *) exit 2 ;; esac
case "$node_bin" in /*) ;; *) exit 2 ;; esac

# Use the selected Node.js for npm and any child processes as well.
export PATH="$(dirname "$node_bin"):$PATH"
npm_cli="$(dirname "$node_bin")/../lib/node_modules/npm/bin/npm-cli.js"
"$node_bin" -e 'if (process.version !== "v24.22.1") { console.error("Node.js 24.22.1 が必要です"); process.exit(1); }'
git -C "$repo_root" diff --quiet HEAD --
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 "$node_bin" "$npm_cli" --prefix "$repo_root" ci
PLAYWRIGHT_SKIP_BROWSER_GC=1 "$node_bin" "$repo_root/node_modules/playwright/cli.js" install chromium
"$node_bin" "$npm_cli" --prefix "$repo_root" run build
"$node_bin" -p 'JSON.stringify({node:process.version, executable:process.execPath, brotli:process.versions.brotli})'
"$node_bin" "$repo_root/node_modules/playwright/cli.js" --version
