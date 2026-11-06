#!/bin/sh
# Starts the switchboard as the unprivileged `node` user. The container starts as root only so
# that data volumes written by earlier images (which ran everything as root) can be handed over.
set -e

if [ "$(id -u)" = "0" ]; then
  for dir in "$DATA_DIR" "$SANDBOX_DIR"; do
    mkdir -p "$dir"
    if [ "$(stat -c %u "$dir")" != "1000" ] || [ -n "$(find "$dir" ! -user 1000 -print -quit)" ]; then
      chown -R node:node "$dir"
    fi
  done
  # setpriv keeps root's environment; a HOME of /root would leave unsandboxed servers (and npx/uv
  # caches) pointing at a directory `node` can't write.
  export HOME=/home/node USER=node LOGNAME=node
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --bounding-set=-all -- "$@"
fi

exec "$@"
