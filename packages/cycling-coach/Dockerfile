# Multi-stage Dockerfile for the cycling-coach binary. Builds the cycling-coach
# workspace closure via pnpm workspace, then ships the self-contained runtime
# produced by modern `pnpm deploy --prod`.

# ── builder ────────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS builder
WORKDIR /app

ARG PNPM_VERSION=11.24.0
ARG PNPM_TARBALL_SHA512=bd27e345e976dcb0be0b7a1228217b049a817e21b1f355c90dbe7dc46671895a8bc1e6d06c24554505ea93ea0b45f489a27ec1bfbc8de6a9659fca0f16fa0000
RUN apk add --no-cache --virtual .pnpm-download curl \
    && curl -fsSL "https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz" -o /tmp/pnpm.tgz \
    && echo "$PNPM_TARBALL_SHA512  /tmp/pnpm.tgz" | sha512sum -c - \
    && npm install --global --ignore-scripts /tmp/pnpm.tgz \
    && test "$(pnpm --version)" = "$PNPM_VERSION" \
    && rm /tmp/pnpm.tgz \
    && apk del .pnpm-download

# Workspace manifests + lockfile for cache hits on dep installs. Only the
# packages cycling-coach actually depends on — the full workspace closure is
# cycling-coach -> core -> {engine, kernel}, engine -> {coach-contract,
# kernel}, sport-cycling -> {engine, kernel}. The remaining workspace packages
# aren't part of the binary and don't need to be visible.
# `pnpm install --filter cycling-coach...` resolves only the cycling-coach
# subgraph and ignores the absent workspace dirs.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
# Workspace patch entries are hashed on every install, even when the patched
# package is outside the filtered subgraph.
COPY patches ./patches
COPY packages/kernel/package.json ./packages/kernel/
COPY packages/coach-contract/package.json ./packages/coach-contract/
COPY packages/engine/package.json ./packages/engine/
COPY packages/core/package.json ./packages/core/
COPY packages/sport-cycling/package.json ./packages/sport-cycling/
COPY packages/cycling-coach/package.json ./packages/cycling-coach/

RUN pnpm install --filter cycling-coach... --frozen-lockfile

# Source after deps for cache reuse.
COPY tools ./tools
COPY packages/kernel ./packages/kernel
COPY packages/coach-contract ./packages/coach-contract
COPY packages/engine ./packages/engine
COPY packages/core ./packages/core
COPY packages/sport-cycling ./packages/sport-cycling
COPY packages/cycling-coach ./packages/cycling-coach
COPY LICENSE NOTICE.md ./

# Only build what cycling-coach needs (`...` = the package + all its deps in
# topo order). Packages outside the closure aren't even copied into the image.
RUN pnpm --config.verify-deps-before-run=false --filter cycling-coach... build

RUN pnpm --filter cycling-coach --prod deploy /app/runtime-bundle \
    && cp packages/cycling-coach/package.json /app/runtime-bundle/package.json

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV CYCLING_COACH_HOME=/data
# Image-backed hosts update by pulling/redeploying the container, not by npm
# self-update inside the running process.
ENV CYCLING_COACH_MANAGED_DEPLOY=1

# su-exec drops root to `node` in the entrypoint after the mounted volume's
# ownership is fixed (managed-platform volumes mount as root).
RUN apk add --no-cache su-exec

COPY --from=builder --chown=root:root /app/runtime-bundle ./
COPY --chown=root:root LICENSE NOTICE.md ./
COPY packages/cycling-coach/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data

# Intentionally NOT `USER node`: the container starts as root so the entrypoint
# can chown the runtime-mounted volume, then execs the process as `node`.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
