# Multi-stage Dockerfile for the cycling-coach binary. Builds Core + sport-cycling
# + cycling-coach via pnpm workspace, then stages the dependency-hermetic CLI
# package with `pnpm deploy --prod`.

# ── builder ────────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a AS builder
WORKDIR /app

# Honor the packageManager pin in root package.json.
RUN corepack enable

# Workspace manifests + lockfile for cache hits on dep installs. Only the
# packages cycling-coach actually depends on (core + sport-cycling + itself);
# the 4 stub packages aren't part of the binary and don't need to be visible.
# `pnpm install --filter cycling-coach...` resolves only the cycling-coach
# subgraph and ignores the absent stub workspace dirs.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/sport-cycling/package.json ./packages/sport-cycling/
COPY packages/cycling-coach/package.json ./packages/cycling-coach/

RUN pnpm install --filter cycling-coach... --frozen-lockfile

# Source after deps for cache reuse.
COPY tools ./tools
COPY packages/core ./packages/core
COPY packages/sport-cycling ./packages/sport-cycling
COPY packages/cycling-coach ./packages/cycling-coach
COPY LICENSE NOTICE.md ./

# Only build what cycling-coach needs (`...` = the package + all its deps in
# topo order). Stubs aren't even copied into the image.
RUN pnpm --filter cycling-coach... build

# pnpm deploy stages the package manifest, README, and bundled dist artifacts.
# --legacy: pnpm 10 made `inject-workspace-packages=true` required for
# `deploy` by default; without that workspace setting, deploy errors with
# ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE. We don't need the injection model
# (cycling-coach bundles @enduragent/* via tsup; workspace deps live in
# devDependencies and get stripped by --prod anyway), so the legacy flag
# is the right opt-out.
RUN pnpm --filter cycling-coach --prod --legacy deploy /app/runtime-bundle

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a AS runtime
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
