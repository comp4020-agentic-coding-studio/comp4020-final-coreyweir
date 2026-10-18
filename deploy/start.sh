#!/bin/bash
# nginx (public, :8080) serves the client (built in the image) and proxies the relays to
# node (private, :8093), which also serves the room documents (Hocuspocus)
# and stores them in SQLite on the fly volume. If either process exits, the
# machine exits and fly restarts it.
set -eu
export RIFF_DB="${RIFF_DB:-/data/riff.sqlite}"
mkdir -p "$(dirname "$RIFF_DB")"
HOST=127.0.0.1 PORT=8093 HEALTH_PORT=8094 node /srv/server/index.mjs &
node_pid=$!
# The machine stops when idle and the next request wakes it. nginx starts
# only once node accepts connections: until :8080 listens, fly's proxy holds
# the request, where an nginx without node behind it would answer 502.
until (exec 3<>/dev/tcp/127.0.0.1/8093) 2>/dev/null; do
  kill -0 "$node_pid" 2>/dev/null || exit 1
  sleep 0.05
done
nginx -c /srv/nginx.conf -g 'daemon off;' &
wait -n
exit 1
