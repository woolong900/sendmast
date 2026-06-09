# syntax=docker/dockerfile:1.7
#
# SendMast unified production image.
#
# Build targets (use `--target=<name>` or compose `build.target`):
#   api             — NestJS API server (HTTP :4000)
#   worker-sender   — BullMQ campaign send worker (no HTTP)
#   worker-events   — BullMQ webhook event ingest worker (no HTTP)
#   worker-import   — BullMQ contact CSV import worker (no HTTP)
#   web             — Caddy serving the built SPA static files + reverse proxy
#                     to internal services. ONE public-facing TLS terminator.
#
# Why a single Dockerfile (not 5):
#   pnpm + turbo monorepo means the install + build steps are >90% shared
#   across all apps. With BuildKit, the `deps` and `build` stages are cached
#   once and reused for every runtime target — five separate Dockerfiles
#   would duplicate (and re-execute) all of that.

ARG NODE_VERSION=22.12.0

# ─── Base image ───────────────────────────────────────────────────────────────
# Bookworm-slim has glibc (argon2 / @prisma/engines need it) and stays small
# (~80MB) compared to the full image. Alpine would also work but Prisma's
# precompiled engines target glibc by default — switching to Alpine would
# require a `binaryTargets = ["linux-musl-openssl-3.0.x"]` opt-in in the
# Prisma schema and an extra cold-start pull, not worth the savings.
FROM node:${NODE_VERSION}-bookworm-slim AS base
# Install pnpm via npm, NOT corepack: corepack on Node 22.12 ships with a
# pnpm-signing key that pnpm 10.x rotated away from, so `corepack prepare
# pnpm@10.x` errors with "Cannot find matching keyid". Going via npm
# sidesteps the whole signing-key dance and adds maybe 30s to the build.
RUN npm install -g pnpm@10.33.4 && pnpm --version
WORKDIR /app
# OpenSSL is needed by Prisma's query engine at runtime; Bookworm-slim
# ships it but the libssl symlinks are missing in some minimal variants.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ─── Build-tools stage ────────────────────────────────────────────────────────
# Native modules (argon2) compile against node-gyp here. Using a separate
# stage keeps build-essential / python out of every runtime image.
FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*
# Copy ONLY manifests first so the install layer caches when only code changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker-sender/package.json apps/worker-sender/
COPY apps/worker-events/package.json apps/worker-events/
COPY apps/worker-import/package.json apps/worker-import/
COPY apps/worker-thumbnail/package.json apps/worker-thumbnail/
COPY apps/worker-shop-sync/package.json apps/worker-shop-sync/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/clickhouse/package.json packages/clickhouse/
COPY packages/shopyy/package.json packages/shopyy/
COPY packages/email-tracking/package.json packages/email-tracking/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile

# ─── Build stage ──────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
# Prisma client must be generated BEFORE compiling api/workers — they import
# `@prisma/client` and tsc needs the generated types.
RUN pnpm --filter @sendmast/db exec prisma generate --schema prisma/schema.prisma
# Single-shot build of every workspace. turbo handles topological order and
# caches per-package — repeat builds skip unchanged packages entirely.
ENV NODE_ENV=production
# Web bundle reads VITE_API_BASE_URL at BUILD time (Vite inlines env vars
# into the JS). In our reverse-proxy setup the web and api share the
# origin, so empty string = same-origin = correct.
ENV VITE_API_BASE_URL=
RUN pnpm build

# ─── Runtime images ──────────────────────────────────────────────────────────
# We initially used `pnpm deploy --prod` to ship a trimmed tree, but pnpm v10
# `deploy` re-hydrates packages from the global store, which OVERWRITES the
# Prisma client generated during the build stage with the un-initialized stub
# (`@prisma/client did not initialize yet`). Re-running `prisma generate` in
# the deploy tree would work but adds another moving part. The simpler fix
# is to copy the build stage's full node_modules — this brings in dev deps
# (~800MB) but gives us deterministic Prisma + Argon2 + native modules with
# zero re-resolution at runtime. With layer reuse, total disk usage stays
# manageable; the runtime images share a single node_modules layer.

# ─── Runtime: API ─────────────────────────────────────────────────────────────
FROM base AS api
ENV NODE_ENV=production
ENV API_PORT=4000
WORKDIR /app/apps/api
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/api /app/apps/api
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/
EXPOSE 4000
USER node
CMD ["node", "dist/main.js"]

# ─── Runtime: worker-sender ───────────────────────────────────────────────────
FROM base AS worker-sender
ENV NODE_ENV=production
WORKDIR /app/apps/worker-sender
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/worker-sender /app/apps/worker-sender
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/
USER node
CMD ["node", "dist/main.js"]

# ─── Runtime: worker-events ───────────────────────────────────────────────────
FROM base AS worker-events
ENV NODE_ENV=production
WORKDIR /app/apps/worker-events
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/worker-events /app/apps/worker-events
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/
USER node
CMD ["node", "dist/main.js"]

# ─── Runtime: worker-shop-sync (shopyy events → orders/attribution + automations) ─
FROM base AS worker-shop-sync
ENV NODE_ENV=production
WORKDIR /app/apps/worker-shop-sync
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/worker-shop-sync /app/apps/worker-shop-sync
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/
USER node
CMD ["node", "dist/main.js"]

# ─── Runtime: worker-import ───────────────────────────────────────────────────
FROM base AS worker-import
ENV NODE_ENV=production
WORKDIR /app/apps/worker-import
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/worker-import /app/apps/worker-import
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/
USER node
CMD ["node", "dist/main.js"]

# ─── Runtime: worker-thumbnail (headless Chromium → campaign list previews) ──
# This is the ONLY image that carries Chromium. We install Debian's `chromium`
# package (pulls its own runtime libs) plus base + CJK fonts so Chinese emails
# render real glyphs instead of tofu. puppeteer-core drives this system binary
# via PUPPETEER_EXECUTABLE_PATH — no bundled-Chromium download bloating the
# shared node_modules layer.
FROM base AS worker-thumbnail
ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     chromium fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/apps/worker-thumbnail
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/worker-thumbnail /app/apps/worker-thumbnail
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/
USER node
CMD ["node", "dist/main.js"]

# ─── Migrator (one-shot, deploy-time only) ───────────────────────────────────
# Runs Prisma + ClickHouse migrations. We reuse the `build` stage as-is
# because it already has prisma CLI, tsx, and the compiled ClickHouse
# migrate script. This image is NOT part of the long-running stack —
# scripts/deploy.sh invokes it once per deploy via `compose run --rm`.
FROM build AS migrator
ENV NODE_ENV=production
WORKDIR /app
# The package.json scripts use dotenv-cli to read ../../.env; in the
# container we want to read env vars straight from the process. Invoke
# the underlying tools directly.
CMD ["sh", "-c", "pnpm --filter @sendmast/db exec prisma migrate deploy --schema prisma/schema.prisma && pnpm --filter @sendmast/clickhouse exec tsx src/migrate.ts"]

# ─── Runtime: web (Caddy + static SPA + reverse proxy) ────────────────────────
# Caddy is the ONLY public-facing service: it terminates TLS via Let's
# Encrypt, serves the SPA static files at `/`, proxies API + tracking +
# public-bucket requests to the right internal upstreams. No nginx, no
# Certbot, no manual cert renewals.
FROM caddy:2.8-alpine AS web
COPY --from=build /app/apps/web/dist /srv/web
# Apex marketing site (sendmast.com landing page). Plain HTML + Tailwind CDN,
# no build step. Edit marketing/index.html and rebuild this image to ship.
COPY marketing /srv/marketing
COPY docker/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
