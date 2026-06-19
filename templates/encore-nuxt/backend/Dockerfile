# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

ENV PATH="/root/.encore/bin:${PATH}"
ENV ENCORE_INFRA_CONFIG_PATH=/encore/infra.config.json
ENV ENCORE_TELEMETRY_DISABLED=1

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
COPY scripts/nstack-cron-runner.mjs ./scripts/nstack-cron-runner.mjs

ARG ENCORE_INFRA_CONFIG_B64
WORKDIR /workspace/backend
RUN mkdir -p /encore .encore/nstack/cron-runner \
  && node -e 'const fs = require("fs"); const data = process.env.ENCORE_INFRA_CONFIG_B64 || ""; if (!data) throw new Error("ENCORE_INFRA_CONFIG_B64 is required"); fs.writeFileSync("/encore/infra.config.json", Buffer.from(data, "base64"));' \
  && encore gen wrappers \
  && encore debug meta -f json > .encore/nstack/meta.json \
  && node ../scripts/nstack-cron-runner.mjs .encore/nstack/meta.json encore.gen/internal/entrypoints/combined/main.ts encore.gen/internal/entrypoints/combined/nstack-cron-runner.ts \
  && if [ -f encore.gen/internal/entrypoints/combined/nstack-cron-runner.ts ]; then \
    tsbundler-encore --bundle --engine=node:22 --outdir=.encore/nstack/cron-runner encore.gen/internal/entrypoints/combined/nstack-cron-runner.ts; \
  fi \
  && tsbundler-encore --bundle --engine=node:22 --outdir=.encore/nstack/bundle encore.gen/internal/entrypoints/combined/main.ts \
  && find .encore/nstack -name '*.map' -delete \
  && encore debug meta -f proto > /encore/meta \
  && mkdir -p /encore/runtimes/js \
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
ENV RUST_LOG=info
ENV PORT=8080
ENV ENCORE_INFRA_CONFIG_PATH=/encore/infra.config.json
ENV ENCORE_APP_META_PATH=/encore/meta
ENV ENCORE_RUNTIME_LIB=/encore/runtimes/js/encore-runtime.node
ENV GIT_COMMIT=${NSTACK_GIT_COMMIT}
ENV IMAGE_TAG=${NSTACK_IMAGE_TAG}

COPY --from=build /workspace/backend/package.json ./package.json
COPY --from=build /root/.encore/runtimes/js/encore.dev ./node_modules/encore.dev
COPY --from=build /workspace/backend/.encore/nstack/bundle ./.encore/build/combined
COPY --from=build /workspace/backend/.encore/nstack/cron-runner ./.encore/nstack/cron-runner
COPY --from=build /encore /encore

RUN --mount=type=bind,source=.,target=/context,ro <<'EOF'
set -eu
mkdir -p /encore/nstack /usr/local/bin
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const gitDir = "/context/.git";
let commit = process.env.NSTACK_GIT_COMMIT || "local";

function read(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function isSha(value) {
  return /^[0-9a-f]{40}$/i.test(value);
}

const head = read(path.join(gitDir, "HEAD"));
if (isSha(head)) {
  commit = head;
} else if (head.startsWith("ref: ")) {
  const ref = head.slice(5).trim();
  const loose = read(path.join(gitDir, ref));
  if (isSha(loose)) {
    commit = loose;
  } else {
    for (const line of read(path.join(gitDir, "packed-refs")).split(/\n/)) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && isSha(sha)) {
        commit = sha;
        break;
      }
    }
  }
}

fs.writeFileSync("/encore/nstack/git-commit", `${commit}\n`);
NODE
cat > /usr/local/bin/nstack-backend-entrypoint <<'SH'
#!/bin/sh
set -eu
if [ -s /encore/nstack/git-commit ]; then
  GIT_COMMIT="$(cat /encore/nstack/git-commit)"
  export GIT_COMMIT
  APP_VERSION="$GIT_COMMIT"
  export APP_VERSION
fi
exec node /workspace/backend/.encore/build/combined/combined/main.mjs
SH
chmod +x /usr/local/bin/nstack-backend-entrypoint
EOF

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/nstack-backend-entrypoint"]
