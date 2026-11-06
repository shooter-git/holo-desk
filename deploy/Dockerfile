# HO[LO] Desk: the server and the built studio in one small image.
# Built by `pnpm up` (deploy/compose.yml). The data folder (projects, sample packs) is a volume.

FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS base
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

# ---- HO[LO] Engine for the computers you play on (Windows and Linux), built from these same sources, so
# the studio offers the one that plays as it does (macOS ones build on a Mac: see the releases) ----
FROM base AS engine
RUN apk add --no-cache curl xz zip
# Zig cross-compiles the Engine's native piece: this release, its download checked
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) arch=x86_64; sum=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00 ;; \
      aarch64) arch=aarch64; sum=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17 ;; \
      *) echo "No Zig 0.16.0 for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -sSfLo /tmp/zig.tar.xz "https://ziglang.org/download/0.16.0/zig-$arch-linux-0.16.0.tar.xz"; \
    echo "$sum  /tmp/zig.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/zig; \
    tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1; \
    rm /tmp/zig.tar.xz
ENV ZIG=/opt/zig/zig
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/companion/package.json apps/companion/
COPY packages/session/package.json packages/session/
COPY packages/engine/package.json packages/engine/
RUN pnpm install --frozen-lockfile --filter @holo/companion...
# what the build downloads (miniaudio, Node's own Windows and Linux binaries, each checked), kept while
# the build script stays the same
COPY apps/companion/build.mjs apps/companion/
RUN node apps/companion/build.mjs --fetch win32-x64 linux-x64
COPY tsconfig.base.json tsconfig.node.json ./
COPY packages ./packages
COPY apps/companion ./apps/companion
# a zip keeps a Linux program a program
RUN node apps/companion/build.mjs --release win32-x64 linux-x64 \
 && cd apps/companion/dist \
 && zip -9 -q holo-engine-linux-x64.zip holo-engine-linux-x64 \
 && rm holo-engine-linux-x64

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
# the Engine downloads the studio offers (Audio & MIDI settings), and the engine they carry
COPY --from=engine /app/apps/companion/dist/holo-engine-windows-x64.exe /app/apps/companion/dist/holo-engine-linux-x64.zip /app/apps/companion/dist/engine.json ./apps/companion/dist/
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
