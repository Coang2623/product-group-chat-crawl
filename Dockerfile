# Debian rather than Alpine: better-sqlite3 and sharp both ship prebuilt glibc
# binaries, so musl would force a slow source build of each.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# The app depends on the library at the repository root (file:../..), so both
# manifests must be present before install can resolve the workspace.
COPY package.json package-lock.json ./
COPY apps/product-monitor/package.json apps/product-monitor/
RUN npm ci

# The library's build output is committed, and package.json points main/exports
# at it, so the image consumes it the way any published dependency would. It is
# also pinned to an older @types/node and does not typecheck against this one,
# so rebuilding it here would fail on code the app does not own.
COPY dist/ dist/
COPY index.d.ts ./

COPY apps/product-monitor/ apps/product-monitor/
RUN npm --prefix apps/product-monitor run build

# Drop dev dependencies, then rebuild the native modules so the binaries in the
# runtime image match its Node ABI rather than the builder's.
RUN npm prune --omit=dev \
    && npm rebuild better-sqlite3 sharp


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PRODUCT_MONITOR_DATA_DIR=/data \
    PRODUCT_MONITOR_HOST=0.0.0.0 \
    PRODUCT_MONITOR_PORT=4173

WORKDIR /app

COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY --from=build /app/package.json ./
COPY --from=build /app/apps/product-monitor/dist apps/product-monitor/dist/
# Workspaces hoist dependencies to the root node_modules, so the app has no
# node_modules of its own to copy.
COPY --from=build /app/apps/product-monitor/package.json apps/product-monitor/

# The database, photos, workbook and Zalo session all live here. Config rejects
# a data directory inside the repository, so this must stay outside /app.
VOLUME ["/data"]
EXPOSE 4173

# Own the data directory before dropping privileges; the image's own files stay
# root-owned and read-only to the app.
RUN mkdir -p /data && chown -R node:node /data
USER node

# The listener holds a websocket and writes SQLite, so it must see SIGTERM
# directly rather than through a shell.
CMD ["node", "apps/product-monitor/dist/server/index.js"]
