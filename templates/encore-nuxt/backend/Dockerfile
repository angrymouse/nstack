# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

ENV PATH="/root/.encore/bin:${PATH}"
ENV ENCORE_INFRA_CONFIG_PATH=/encore/infra.config.json

ARG TARGETARCH=amd64
ARG ENCORE_VERSION=1.57.8
ARG ENCORE_SHA256_AMD64=59ac867590cb5572410b8b911c28f8263aeb0df5a9eccd2042a6a64a26597d4e
ARG ENCORE_SHA256_ARM64=ae41ea792e77ee2eba961075a2858f6228bb25a594e08d49ea122ceac187bcc1
ADD https://d2f391esomvqpi.cloudfront.net/encore-${ENCORE_VERSION}-linux_${TARGETARCH}.tar.gz /tmp/encore.tar.gz
RUN case "$TARGETARCH" in \
    amd64) encore_sha="$ENCORE_SHA256_AMD64" ;; \
    arm64) encore_sha="$ENCORE_SHA256_ARM64" ;; \
    *) echo "Unsupported Encore target architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && echo "$encore_sha  /tmp/encore.tar.gz" | sha256sum -c - \
  && mkdir -p /root/.encore \
  && tar -C /root/.encore -xzf /tmp/encore.tar.gz \
  && chmod +x /root/.encore/bin/* \
  && rm /tmp/encore.tar.gz \
  && test -x /root/.encore/bin/encore \
  && test -x /root/.encore/bin/tsbundler-encore

COPY pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY package.json ./
COPY backend/package.json ./backend/package.json

RUN --mount=type=cache,id=nstack-backend-pnpm,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --filter ./backend... --prefer-offline --ignore-scripts --frozen-lockfile=false

COPY backend ./backend

ARG ENCORE_INFRA_CONFIG_B64
RUN mkdir -p /encore \
  && node -e 'const fs = require("fs"); const data = process.env.ENCORE_INFRA_CONFIG_B64 || ""; if (!data) throw new Error("ENCORE_INFRA_CONFIG_B64 is required"); fs.writeFileSync("/encore/infra.config.json", Buffer.from(data, "base64"));'

WORKDIR /workspace/backend
RUN encore gen wrappers
RUN tsbundler-encore --bundle --engine=node:22 --outdir=.encore/nstack/bundle encore.gen/internal/entrypoints/combined/main.ts
RUN encore debug meta -f proto > /encore/meta
RUN mkdir -p /encore/runtimes/js \
  && cp /root/.encore/runtimes/js/encore-runtime.node /encore/runtimes/js/encore-runtime.node \
  && cp -R /root/.encore/runtimes/js/encore.dev /encore/runtimes/js/encore.dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /workspace/backend

RUN --mount=type=cache,id=nstack-backend-runtime-apt,target=/var/cache/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG NSTACK_GIT_COMMIT=local
ARG NSTACK_IMAGE_TAG=local
ENV NODE_ENV=production
ENV PORT=8080
ENV ENCORE_INFRA_CONFIG_PATH=/encore/infra.config.json
ENV ENCORE_APP_META_PATH=/encore/meta
ENV ENCORE_RUNTIME_LIB=/encore/runtimes/js/encore-runtime.node
ENV GIT_COMMIT=${NSTACK_GIT_COMMIT}
ENV IMAGE_TAG=${NSTACK_IMAGE_TAG}

COPY --from=build /workspace/backend/package.json ./package.json
COPY --from=build /root/.encore/runtimes/js/encore.dev ./node_modules/encore.dev
COPY --from=build /workspace/backend/.encore/nstack/bundle ./.encore/build/combined
COPY --from=build /encore /encore

EXPOSE 8080
ENTRYPOINT ["node", "--enable-source-maps", "/workspace/backend/.encore/build/combined/combined/main.mjs"]
