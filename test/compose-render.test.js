import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDokployCompose } from "../src/render/compose.js";

test("compose renderer quotes dynamic values and omits cron runner containers", () => {
  const output = renderDokployCompose({
    config: {
      app: { slug: "quoted-app", domain: "app.example.test" },
      deploy: { target: "prod" },
    },
    resources: {
      databases: [{ name: "app" }],
      caches: [],
      topics: [{ name: "events", subscriptions: [] }],
      secrets: ["API_TOKEN"],
      crons: [{ name: "nightly" }],
    },
    images: {
      backend: "ghcr.io/acme/app/backend:tag:with:colon",
      frontend: "ghcr.io/acme/app/frontend:tag:with:colon",
    },
    release: {
      commit: "abc: def # not a yaml comment",
      tag: "tag:with:colon",
    },
  });

  assert.match(output, /image: "ghcr\.io\/acme\/app\/backend:tag:with:colon"/);
  assert.match(output, /APP_VERSION: "\$\{NSTACK_GIT_COMMIT:-local\}"/);
  assert.match(output, /NSTACK_POSTGRES_PASSWORD: "\$\{NSTACK_POSTGRES_PASSWORD:\?set NSTACK_POSTGRES_PASSWORD\}"/);
  assert.match(output, /NUXT_API_SERVER_BASE_URL: "http:\/\/quoted-app-backend:8080"/);
  assert.match(output, /aliases:\n          - "quoted-app-backend"/);
  assert.match(output, /command: "\/nsqd --lookupd-tcp-address=quoted-app-nsqlookupd:4160 --broadcast-address=quoted-app-nsqd --data-path=\/data"/);
  assert.match(output, /aliases:\n          - "quoted-app-nsqd"/);
  assert.doesNotMatch(output, /cron-runner/);
  assert.doesNotMatch(output, /healthcheck:/);
});

test("compose renderer keeps source build values in Dokploy env placeholders", () => {
  const output = renderDokployCompose({
    config: {
      app: { slug: "source-app", domain: "source.example.test" },
      deploy: { target: "prod", platform: "linux/amd64" },
      paths: {
        backendDockerfile: "backend/Dockerfile",
        frontendDockerfile: "frontend/Dockerfile",
      },
    },
    resources: {
      databases: [],
      caches: [],
      topics: [],
      secrets: [],
      crons: [],
    },
    images: {},
    build: {
      context: "${NSTACK_BUILD_CONTEXT:-../..}",
      services: {
        backend: {
          dockerfile: "backend/Dockerfile",
          args: {
            ENCORE_INFRA_CONFIG_B64: "${ENCORE_INFRA_CONFIG_B64:?set ENCORE_INFRA_CONFIG_B64}",
            NSTACK_GIT_COMMIT: "${NSTACK_GIT_COMMIT:-local}",
            NSTACK_IMAGE_TAG: "${NSTACK_IMAGE_TAG:-local}",
          },
        },
        frontend: { dockerfile: "frontend/Dockerfile" },
      },
    },
    release: { commit: "abc123", tag: "abc123" },
  });

  assert.match(output, /context: "\$\{NSTACK_BUILD_CONTEXT:-\.\.\/\.\.\}"/);
  assert.match(output, /ENCORE_INFRA_CONFIG_B64: "\$\{ENCORE_INFRA_CONFIG_B64:\?set ENCORE_INFRA_CONFIG_B64\}"/);
  assert.doesNotMatch(output, /abc123/);
});

test("compose renderer provisions RustFS for Encore object storage buckets", () => {
  const output = renderDokployCompose({
    config: {
      app: { slug: "bucket-app", domain: "bucket.example.test" },
      deploy: { target: "prod" },
    },
    resources: {
      databases: [],
      caches: [],
      topics: [],
      buckets: [{ name: "uploads" }, { name: "public-assets", public: true }],
      secrets: [],
      crons: [],
    },
    images: {
      backend: "ghcr.io/acme/bucket/backend:tag",
      frontend: "ghcr.io/acme/bucket/frontend:tag",
    },
    release: { commit: "abc123", tag: "tag" },
  });

  assert.match(output, /rustfs:\n\s+image: "rustfs\/rustfs:latest"/);
  assert.match(output, /RUSTFS_ACCESS_KEY: "\$\{NSTACK_MINIO_ACCESS_KEY:\?set NSTACK_MINIO_ACCESS_KEY\}"/);
  assert.match(output, /RUSTFS_SECRET_KEY: "\$\{NSTACK_MINIO_SECRET_KEY:\?set NSTACK_MINIO_SECRET_KEY\}"/);
  assert.match(output, /RUSTFS_SERVER_DOMAINS: "bucket-app-rustfs:9000"/);
  assert.match(output, /aliases:\n\s+- "bucket-app-rustfs"/);
  assert.match(output, /- "bucket-app-uploads\.bucket-app-rustfs"/);
  assert.match(output, /- "bucket-app-public-assets\.bucket-app-rustfs"/);
  assert.match(output, /rustfs-init:\n\s+image: "minio\/mc:latest"/);
  assert.match(output, /rustfs-public:\n\s+image: "nginx:1\.27-alpine"/);
  assert.match(output, /proxy_set_header Host bucket-app-rustfs:9000/);
  assert.match(output, /proxy_pass http:\/\/bucket-app-rustfs:9000/);
  assert.match(output, /entrypoint:\n\s+- "\/bin\/sh"/);
  assert.match(output, /command:\n\s+- "-c"\n\s+- "until mc alias set local/);
  assert.match(output, /mc mb --ignore-existing local\/bucket-app-uploads/);
  assert.match(output, /mc anonymous set download local\/bucket-app-public-assets/);
  assert.doesNotMatch(output, /backend:[\s\S]*depends_on:[\s\S]*rustfs-init:[\s\S]*condition: "service_completed_successfully"/);
  assert.match(output, /rustfs_data: \{\}/);
});

test("compose renderer runs Encore database migrations with the pinned go-migrate image", () => {
  const output = renderDokployCompose({
    config: {
      app: { slug: "migrated-app", domain: "migrated.example.test" },
      deploy: { target: "prod" },
      paths: { backend: "backend" },
    },
    resources: {
      databases: [{ name: "app", migrations: "api/migrations" }],
      caches: [],
      topics: [],
      buckets: [],
      secrets: [],
      crons: [],
    },
    infra: {
      postgres: {
        host: "migrated-app-postgres-a1b2c3:5432",
        database: "app",
        user: "nstack",
      },
    },
    images: {
      backend: "ghcr.io/acme/migrated/backend:tag",
      frontend: "ghcr.io/acme/migrated/frontend:tag",
    },
    release: { commit: "abc123", tag: "tag" },
  });

  assert.match(output, /migrate-app:\n\s+image: "migrate\/migrate:v4\.15\.2"/);
  assert.match(output, /- "-path=\/migrations"/);
  assert.match(output, /- "-database=postgres:\/\/nstack:\$\{NSTACK_POSTGRES_PASSWORD:\?set NSTACK_POSTGRES_PASSWORD\}@migrated-app-postgres-a1b2c3:5432\/app\?sslmode=disable"/);
  assert.match(output, /- "up"/);
  assert.match(output, /- "\.\.\/\.\.\/backend\/api\/migrations:\/migrations:ro"/);
  assert.match(output, /migrate-app:[\s\S]*networks:[\s\S]*dokploy-network: \{\}/);
  assert.match(output, /networks:\n\s+dokploy-network:\n\s+external: true/);
  assert.match(output, /backend:[\s\S]*depends_on:[\s\S]*migrate-app:[\s\S]*condition: "service_completed_successfully"/);
});
