#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=./runtime-worktree.sh
source "$SCRIPT_DIR/runtime-worktree.sh" --source-only

assert_file_exists() {
  local path="$1"
  local message="$2"

  if [ ! -f "$path" ]; then
    echo "FAIL: $message"
    echo "  missing: $path"
    exit 1
  fi
}

assert_file_contains() {
  local path="$1"
  local needle="$2"
  local message="$3"

  if ! grep -q "$needle" "$path"; then
    echo "FAIL: $message"
    echo "  file: $path"
    echo "  missing: $needle"
    exit 1
  fi
}

test_seed_runtime_config_syncs_runtime_state() {
  local tmp_root source_dir runtime_dir
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' RETURN

  source_dir="$(abs_path "$tmp_root/source")"
  runtime_dir="$(abs_path "$tmp_root/runtime")"

  mkdir -p "$source_dir/.cat-cafe" "$source_dir/packages/api/uploads" "$runtime_dir"
  echo "API_SERVER_PORT=3004" > "$source_dir/.env"
  echo '{"breeds":[{"id":"codex"}]}' > "$source_dir/.cat-cafe/cat-catalog.json"
  echo '{"codex-2":{"authType":"oauth"}}' > "$source_dir/.cat-cafe/accounts.json"
  echo '{"codex-2":{"apiKey":"secret"}}' > "$source_dir/.cat-cafe/credentials.json"
  echo "avatar" > "$source_dir/packages/api/uploads/avatar-owner.jpg"

  PROJECT_DIR="$source_dir"
  RUNTIME_DIR="$runtime_dir"
  CAT_CAFE_RUNTIME_STATE_SOURCE="$source_dir"

  seed_runtime_config_from_project

  assert_file_exists "$runtime_dir/.env" "runtime .env should be synced"
  assert_file_exists "$runtime_dir/.cat-cafe/cat-catalog.json" "runtime cat catalog should be synced"
  assert_file_exists "$runtime_dir/.cat-cafe/accounts.json" "runtime accounts should be synced"
  assert_file_exists "$runtime_dir/.cat-cafe/credentials.json" "runtime credentials should be synced"
  assert_file_exists "$runtime_dir/packages/api/uploads/avatar-owner.jpg" "runtime uploads should be synced"
  assert_file_contains "$runtime_dir/.cat-cafe/accounts.json" "codex-2" "runtime accounts should preserve codex-2"

  echo "PASS: runtime state sync copies env, cat config, accounts, credentials, and uploads"
}

test_seed_runtime_config_refreshes_existing_config() {
  local tmp_root source_dir runtime_dir
  tmp_root="$(mktemp -d)"
  trap 'rm -rf "$tmp_root"' RETURN

  source_dir="$(abs_path "$tmp_root/source")"
  runtime_dir="$(abs_path "$tmp_root/runtime")"

  mkdir -p "$source_dir/.cat-cafe" "$runtime_dir/.cat-cafe"
  echo '{"breeds":[{"id":"new"}]}' > "$source_dir/.cat-cafe/cat-catalog.json"
  echo '{"breeds":[]}' > "$runtime_dir/.cat-cafe/cat-catalog.json"

  PROJECT_DIR="$source_dir"
  RUNTIME_DIR="$runtime_dir"
  CAT_CAFE_RUNTIME_STATE_SOURCE="$source_dir"

  seed_runtime_config_from_project

  assert_file_contains "$runtime_dir/.cat-cafe/cat-catalog.json" '"id":"new"' \
    "runtime catalog should refresh stale existing config"

  echo "PASS: runtime state sync refreshes stale existing config"
}

test_usage_documents_runtime_state_sync() {
  local output
  output="$(usage)"
  if [[ "$output" != *"Runtime state sync:"* ]]; then
    echo "FAIL: usage should document runtime state sync"
    exit 1
  fi
  echo "PASS: usage documents runtime state sync"
}

test_seed_runtime_config_syncs_runtime_state
test_seed_runtime_config_refreshes_existing_config
test_usage_documents_runtime_state_sync
