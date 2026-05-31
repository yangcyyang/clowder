#!/usr/bin/env bash
# Update Skills Dashboard
# 用法：./run.sh

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"

cd "$PROJECT_ROOT"
echo "🔍 Scanning skill directories..."
pnpm exec tsx cat-cafe-skills/update-skills-dashboard/scripts/generate-dashboard.ts
