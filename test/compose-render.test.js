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
      topics: [],
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
  assert.doesNotMatch(output, /cron-runner/);
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
