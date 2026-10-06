FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
COPY package.json pnpm-lock.yaml* ./
COPY . .

FROM base AS web
WORKDIR /app
RUN pnpm install --frozen-lockfile=false
CMD ["pnpm", "--dir", "apps/web", "dev"]

FROM base AS api
WORKDIR /app
RUN pnpm install --frozen-lockfile=false
CMD ["pnpm", "--dir", "apps/api", "dev"]

FROM base AS worker
WORKDIR /app
RUN pnpm install --frozen-lockfile=false
CMD ["pnpm", "--dir", "apps/worker", "dev"]
