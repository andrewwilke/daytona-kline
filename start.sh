#!/bin/sh
# Starts the Daytona K-line tool: installs what it needs once, then opens the page.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org, then run this again."
  exit 1
fi
[ -d node_modules ] || { echo "Installing, this happens once..."; npm install || exit 1; }
exec node server.js --open
