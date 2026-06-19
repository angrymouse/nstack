# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

ENV NUXT_TELEMETRY_DISABLED=1

COPY pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./

COPY package.json ./
COPY frontend/package.json ./frontend/package.json

RUN --mount=type=cache,id=nstack-frontend-pnpm,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --filter ./frontend... --prefer-offline --ignore-scripts --frozen-lockfile=false

COPY frontend/nuxt.config.ts ./frontend/nuxt.config.ts

WORKDIR /workspace/frontend
RUN --mount=type=cache,id=nstack-frontend-nuxt,target=/workspace/node_modules/.cache/nuxt \
  --mount=type=cache,id=nstack-frontend-dotnuxt,target=/workspace/frontend/.nuxt \
  --mount=type=cache,id=nstack-frontend-vite,target=/workspace/frontend/node_modules/.cache/vite \
  --mount=type=cache,id=nstack-frontend-jiti,target=/workspace/frontend/node_modules/.cache/jiti \
  NITRO_PRESET=node-server \
  ./node_modules/.bin/nuxt prepare --logLevel=silent

WORKDIR /workspace
COPY frontend/app ./frontend/app
COPY frontend/public ./frontend/public

WORKDIR /workspace/frontend
RUN --mount=type=cache,id=nstack-frontend-nuxt,target=/workspace/node_modules/.cache/nuxt \
  --mount=type=cache,id=nstack-frontend-dotnuxt,target=/workspace/frontend/.nuxt \
  --mount=type=cache,id=nstack-frontend-vite,target=/workspace/frontend/node_modules/.cache/vite \
  --mount=type=cache,id=nstack-frontend-jiti,target=/workspace/frontend/node_modules/.cache/jiti \
  NITRO_PRESET=node-server \
  ./node_modules/.bin/nuxt build --logLevel=silent

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=3000

WORKDIR /app
COPY --from=build /workspace/frontend/.output ./.output

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
