#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXED_NODE_DIR="/Users/cy/.uclaw/node/bin"
FIXED_NODE="$FIXED_NODE_DIR/node"
XCODE_TOOL_DIR="/Applications/Xcode.app/Contents/Developer/usr/bin"

if [ ! -x "$FIXED_NODE" ]; then
  echo "[rebuild-native] fixed Node not found or not executable: $FIXED_NODE" >&2
  exit 1
fi

export PATH="$FIXED_NODE_DIR:$XCODE_TOOL_DIR:/usr/bin:$PATH"

verify_better_sqlite3() {
  (
    cd "$PROJECT_DIR/packages/api"
    "$FIXED_NODE" -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close(); console.log('[rebuild-native] better-sqlite3 OK');"
  )
}

resolve_better_sqlite3_dir() {
  "$FIXED_NODE" -e "const path = require('node:path'); console.log(path.dirname(require.resolve('better-sqlite3/package.json', { paths: [process.argv[1]] })));" "$PROJECT_DIR/packages/api"
}

echo "[rebuild-native] project: $PROJECT_DIR"
echo "[rebuild-native] node: $("$FIXED_NODE" -p '`${process.execPath} ${process.version} modules=${process.versions.modules}`')"

cd "$PROJECT_DIR"
echo "[rebuild-native] rebuilding better-sqlite3 with pinned Node..."
pnpm rebuild --pending better-sqlite3 || pnpm rebuild better-sqlite3

echo "[rebuild-native] verifying better-sqlite3 ABI..."
if verify_better_sqlite3; then
  exit 0
fi

echo "[rebuild-native] pnpm rebuild did not produce a usable binding; running package build-release fallback..."
BETTER_SQLITE3_DIR="$(resolve_better_sqlite3_dir)"
(
  cd "$BETTER_SQLITE3_DIR"
  npm run build-release
)

echo "[rebuild-native] verifying better-sqlite3 ABI after fallback..."
verify_better_sqlite3
