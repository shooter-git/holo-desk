# HO[LO] Desk: the server and the built studio in one small image.
# Built by `pnpm up` (deploy/compose.yml). The data folder (projects, sample packs) is a volume.

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app

# ---- the studio, built ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY packages/session/package.json packages/session/
COPY packages/engine/package.json packages/engine/
COPY packages/music/package.json packages/music/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.node.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm --filter @holo/web build

# ---- only what the server needs to run ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/session/package.json packages/session/
COPY packages/engine/package.json packages/engine/
COPY packages/music/package.json packages/music/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile --prod --filter @holo/server... --filter @holo/cli...

FROM base
# git fetches the sample libraries (pnpm packs install)
RUN apk add --no-cache git
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=deps /app/packages/engine/node_modules ./packages/engine/node_modules
COPY --from=deps /app/packages/music/node_modules ./packages/music/node_modules
COPY --from=deps /app/packages/cli/node_modules ./packages/cli/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/server ./apps/server
COPY packages ./packages
COPY packs ./packs
COPY --from=build /app/apps/web/dist ./apps/web/dist
ENV NODE_ENV=production \
    HOLO_HOST=0.0.0.0 \
    HOLO_PORT=47800 \
    HOLO_DATA_DIR=/data \
    HOLO_CREATIONS_DIR=/creations \
    HOLO_WEB_DIR=/app/apps/web/dist
EXPOSE 47800
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:47800/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/main.ts"]
