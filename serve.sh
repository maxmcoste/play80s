#!/bin/bash
# Start a local HTTP server for the 80s Music Quiz
# Usage: ./serve.sh [port]

PORT=${1:-8090}
cd "$(dirname "$0")/public" || exit 1

echo ""
echo "  ♫  80s Music Quiz"
echo "  ──────────────────────────────────"
echo "  Open:  http://localhost:$PORT"
echo "  Stop:  Ctrl+C"
echo ""

# Try python3 first, then python2, then npx serve
if command -v python3 &>/dev/null; then
  python3 -m http.server "$PORT"
elif command -v python &>/dev/null; then
  python -m SimpleHTTPServer "$PORT"
elif command -v npx &>/dev/null; then
  npx serve -l "$PORT" .
else
  echo "ERROR: No HTTP server found."
  echo "Install python3 or run:  npm install -g serve"
  exit 1
fi
