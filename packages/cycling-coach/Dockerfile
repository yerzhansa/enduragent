# Multi-stage Dockerfile for the cycling-coach binary. Builds the cycling-coach
# workspace closure via pnpm workspace, then ships only the runtime bundle via
# `pnpm deploy --prod` (pnpm-canonical: rewrites workspace:* to real paths,
# strips dev deps, produces a self-contained directory).

# ── builder ────────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder
WORKDIR /app

# Honor the packageManager pin in root package.json.
RUN corepack enable

# Workspace manifests + lockfile for cache hits on dep installs. Only the
# packages cycling-coach actually depends on — the full workspace closure is
# cycling-coach -> core -> {engine, kernel}, engine -> {coach-contract,
# kernel}, sport-cycling -> {engine, kernel}. The remaining workspace packages
# aren't part of the binary and don't need to be visible.
# `pnpm install --filter cycling-coach...` resolves only the cycling-coach
# subgraph and ignores the absent workspace dirs.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
# Root `pnpm.patchedDependencies` entries are hashed on every install, even
# when the patched package is outside the filtered subgraph.
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
RUN pnpm --filter cycling-coach... build

# pnpm deploy: produces a self-contained dir with prod-only deps,
# resolves workspace:* to actual files, the pnpm-canonical Docker pattern.
# --legacy: pnpm 10 made `inject-workspace-packages=true` required for
# `deploy` by default; without that workspace setting, deploy errors with
# ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE. We don't need the injection model
# (cycling-coach bundles @enduragent/* via tsup; workspace deps live in
# devDependencies and get stripped by --prod anyway), so the legacy flag
# is the right opt-out.
# The root `pnpm.patchedDependencies` entry targets a workspace package outside
# this subgraph, so `deploy` aborts with ERR_PNPM_PATCH_NOT_APPLIED. pnpm reads
# that setting only from the root manifest — no CLI or npmrc override exists —
# so drop it from the image's copy once the lockfile-checked install is done.
RUN node -e "const fs=require('node:fs');const m=JSON.parse(fs.readFileSync('package.json','utf8'));delete m.pnpm.patchedDependencies;fs.writeFileSync('package.json',JSON.stringify(m,null,2))"

RUN pnpm --filter cycling-coach --prod --legacy deploy /app/runtime-bundle

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime
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
