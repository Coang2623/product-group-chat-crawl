#!/bin/sh
# Takes ownership of the data directory, then drops to the unprivileged user.
#
# Files arriving by `docker compose cp` keep the uid they had on the host, and a
# bind-mounted directory keeps the host's owner, so /data is regularly not
# writable by uid 1000. SQLite then fails with SQLITE_READONLY or
# SQLITE_CANTOPEN before the server starts -- a crash loop with no obvious cause.
set -e

# setpriv comes with util-linux in the base image, so nothing extra is
# installed. --init-groups keeps the node group, and the exec chain means the
# server still receives SIGTERM directly.
if [ "$(id -u)" = "0" ]; then
    chown -R node:node /data
    exec setpriv --reuid node --regid node --init-groups "$@"
fi

exec "$@"
