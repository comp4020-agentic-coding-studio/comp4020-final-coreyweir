#!/bin/bash
# nginx (public, :8080) serves the prebuilt client and proxies the relays to
# node (private, :8093), which also runs the Yjs server persisted to the fly
# volume. If either process exits, the machine exits and fly restarts it.
set -eu
export YPERSISTENCE="${YPERSISTENCE:-/data/yjs}"
mkdir -p "$YPERSISTENCE"
HOST=127.0.0.1 PORT=8093 HEALTH_PORT=8094 node /srv/server/index.mjs &
nginx -c /srv/nginx.conf -g 'daemon off;' &
wait -n
exit 1
