FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10 --activate

COPY . .
RUN pnpm install --frozen-lockfile --filter "@workspace/api-server..."
RUN pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production \
    AI_PROVIDER=gemini

EXPOSE 10000
CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]
