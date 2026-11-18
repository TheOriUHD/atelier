#!/bin/sh
# The container's first process: the demo's data into place, the demo model beside the server, then the server itself.
set -e
mkdir -p /data
cp -a /demo-data/. /data/
mkdir -p /data/home
node /app/demo-model.mjs &
exec node /app/server.mjs
