#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to launch Follett Launch QA."
  echo "Please install Node.js 20+ and try again."
  read -n 1 -s -r -p "Press any key to close..."
  echo
  exit 1
fi

node scripts/launch-local.js
