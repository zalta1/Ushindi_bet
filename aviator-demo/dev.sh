#!/bin/sh
set -eu
cd "$(dirname "$0")"
PORT=5181 npx tsx src/server/index.ts &
server=$!
trap 'kill "$server"' EXIT INT TERM
npx vite --host 127.0.0.1 --port 5180 --strictPort
