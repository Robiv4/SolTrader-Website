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

# ml-trainer: web-started ML training jobs (separate from the trading worker). Debian (glibc) for the LightGBM wheels;
# the Python environment lives in /opt/ml-venv (ML_PYTHON). Datasets / models are mounted volumes (see compose).
FROM node:22-bookworm-slim AS ml-trainer
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libgomp1 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
COPY ml/requirements.txt /tmp/ml-requirements.txt
RUN python3 -m venv /opt/ml-venv && /opt/ml-venv/bin/pip install --no-cache-dir --disable-pip-version-check -r /tmp/ml-requirements.txt
COPY . .
RUN pnpm install --frozen-lockfile=false && pnpm --filter @soltrader/worker exec prisma generate --schema ../../prisma/schema.prisma
ENV ML_PYTHON=/opt/ml-venv/bin/python
CMD ["pnpm", "--dir", "apps/worker", "training"]
