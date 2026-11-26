#!/bin/bash
# To-Do List — iteration 2
# The app is plain static files, so "running" it just means serving the folder.
# Any static server works; python3 is used here because it needs no install.
set -eu

PORT="${1:-8123}"
cd "$(dirname "$0")"

echo "To-Do List is at http://0.0.0.0:${PORT}/  (reached from other machines as http://<this-host-ip>:${PORT}/)  (Ctrl-C to stop)"
exec python3 -m http.server "$PORT" --directory "$(pwd)"
