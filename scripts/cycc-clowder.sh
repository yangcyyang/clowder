#!/usr/bin/env bash
set -euo pipefail

CYCC_CLI_PATH="${CYCC_CLI_PATH:-/Users/cy/Documents/03 life/AI design/CYCC/dist/cli.js}"

if [[ ! -f "$CYCC_CLI_PATH" ]]; then
  echo "CYCC CLI not found: $CYCC_CLI_PATH" >&2
  exit 127
fi

# CYCC is normally used with Anthropic-compatible gateways. Keep the key/model
# controlled by the Clowder account settings, but default the base URL to the
# local CYCC/Kimi setup if the account did not provide one.
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.kimi.com/coding/}"

exec bun "$CYCC_CLI_PATH" "$@"
