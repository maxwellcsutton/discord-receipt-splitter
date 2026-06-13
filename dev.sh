#!/usr/bin/env bash
set -euo pipefail

# Local development script for receipt-bot

# Check for .env file
if [ ! -f .env ]; then
  echo "ERROR: .env file not found."
  echo "Copy .env.example to .env and fill in your values:"
  echo "  cp .env.example .env"
  exit 1
fi

# Check required env vars are set (not just present but non-empty)
source .env
missing=()
[ -z "${DISCORD_TOKEN:-}" ] && missing+=("DISCORD_TOKEN")
[ -z "${ANTHROPIC_API_KEY:-}" ] && missing+=("ANTHROPIC_API_KEY")

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: The following required env vars are missing or empty in .env:"
  for var in "${missing[@]}"; do
    echo "  - $var"
  done
  exit 1
fi

# Ensure dependencies are installed
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# Create data directory if it doesn't exist
mkdir -p data

echo "Starting receipt-bot in development mode (hot reload)..."
npx tsx watch src/index.ts
