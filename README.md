# sendwalk

Enterprise email marketing platform (Omnisend-like). Built for multi-tenant SaaS, supporting millions of contacts and tens of millions of daily emails through Azure Communication Services Email.

## Tech Stack

| Layer       | Choice                                       |
| ----------- | -------------------------------------------- |
| Frontend    | React 18 + Vite + TypeScript + Tailwind + shadcn/ui + ECharts |
| Backend API | NestJS + TypeScript                          |
| Workers     | NestJS + BullMQ                              |
| ORM         | Prisma (PostgreSQL)                          |
| Business DB | PostgreSQL 16 (partitioned)                  |
| Analytics DB| ClickHouse                                   |
| Cache/Queue | Redis 7 + BullMQ                             |
| Object Store| MinIO (S3 compatible)                        |
| Email       | Azure Communication Services Email           |
| Template    | GrapesJS + MJML                              |

## Repository Layout

```
apps/
  web/                # React frontend
  api/                # NestJS HTTP API + Webhook receiver
  worker-sender/      # Sends emails through ACS
  worker-events/      # Aggregates open/click/bounce events into ClickHouse
  worker-import/      # CSV import processor
  worker-shop-sync/   # Shopify/WooCommerce sync (v0.5)
packages/
  db/                 # Prisma schema + migrations + seed
  clickhouse/         # ClickHouse client + DDL
  shared/             # Shared types/DTOs/Zod schemas
  email-tracking/     # Token signing, pixel, link rewrite, RFC 8058 unsubscribe
docker/
  docker-compose.yml  # Local dev infra (pg + redis + ch + minio + mailhog)
docs/
  requirements/       # Original requirements + reference screenshots
```

## Prerequisites

- **Node.js** 20+
- **pnpm** 9+ (`npm i -g pnpm`)
- **Docker** + Docker Compose (for local infra)

## Quickstart

```bash
cp .env.example .env

pnpm install

pnpm infra:up

pnpm db:migrate
pnpm ch:migrate

pnpm dev
```

Services are reachable at:

- Web UI: http://localhost:5173
- API + Swagger: http://localhost:4000/api/docs
- Mailhog UI: http://localhost:8025
- MinIO Console: http://localhost:9001 (sendwalk / sendwalk-secret)
- ClickHouse Play: http://localhost:8123/play

## Common Scripts

```bash
pnpm dev           # all apps in watch mode
pnpm build         # build all packages
pnpm typecheck     # tsc --noEmit across the monorepo
pnpm lint          # eslint
pnpm test          # vitest

pnpm infra:up      # start docker dev infra
pnpm infra:down    # stop it
pnpm infra:logs    # tail logs

pnpm db:generate   # prisma generate
pnpm db:migrate    # prisma migrate dev
pnpm db:seed       # seed sample data
pnpm ch:migrate    # apply ClickHouse DDL
```

## Versioning Roadmap

- **v0.1 (current)** Auth + sender domain + contact lists + CSV import + template editor + campaigns + send + tracking + analytics + dashboard (no segmentation, no shop attribution)
- **v0.2** Segment builder, large CSV optimizations, warm-up
- **v0.3** Custom merge tags, A/B testing
- **v0.4** Behavioral segments
- **v0.5** Shopify / WooCommerce / custom shop integration + attribution
- **v0.6** Plans / Stripe billing / quotas / team invites / i18n
- **v1.0** Multi-region, IP pool management, advanced anti-abuse

See [docs/architecture.md](docs/architecture.md) for the full architecture.
