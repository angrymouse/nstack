import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEncoreInfra } from "../src/render/infra.js";

test("infra renderer keeps Encore database resource key separate from physical database name", () => {
  const output = renderEncoreInfra({
    config: {
      app: { slug: "demo", domain: "demo.example.test" },
      deploy: { target: "prod" },
    },
    resources: {
      services: ["api"],
      metadata: { gateways: ["api-gateway"] },
      databases: [{ name: "app" }],
      topics: [],
      caches: [],
      secrets: [],
    },
    infra: {
      postgres: {
        host: "postgres:5432",
        database: "demo_prod",
        user: "nstack",
      },
    },
  });

  const infra = JSON.parse(output);
  assert.deepEqual(Object.keys(infra.sql_servers[0].databases), ["app"]);
  assert.equal(infra.sql_servers[0].databases.app.name, "demo_prod");
});

test("infra renderer uses app-specific NSQ hostnames for shared Dokploy hosts", () => {
  const output = renderEncoreInfra({
    config: {
      app: { slug: "demo", domain: "demo.example.test" },
      deploy: { target: "prod" },
    },
    resources: {
      services: [{ name: "api" }],
      metadata: { gateways: ["api-gateway"] },
      databases: [],
      topics: [{ name: "events", subscriptions: [{ name: "consumer" }] }],
      caches: [],
      secrets: [],
    },
    infra: {},
  });

  const infra = JSON.parse(output);
  assert.equal(infra.pubsub[0].hosts, "demo-nsqd:4150");
});

test("infra renderer maps Encore caches, buckets, and secrets to Dokploy-backed services", () => {
  const output = renderEncoreInfra({
    config: {
      app: { slug: "demo", domain: "demo.example.test" },
      deploy: { target: "prod" },
    },
    resources: {
      services: [{ name: "api" }],
      metadata: { gateways: [] },
      databases: [],
      topics: [],
      caches: [{ name: "sessions" }, { name: "jobs" }],
      buckets: [{ name: "uploads" }, { name: "public-assets", public: true }],
      secrets: ["STRIPE_SECRET"],
    },
    infra: {
      redis: { host: "demo-redis:6379" },
      objectStorage: {
        endpoint: "http://demo-minio:9000",
        region: "us-east-1",
      },
    },
  });

  const infra = JSON.parse(output);
  assert.deepEqual(infra.secrets, { STRIPE_SECRET: { $env: "STRIPE_SECRET" } });
  assert.equal(infra.redis.sessions.host, "demo-redis:6379");
  assert.equal(infra.redis.sessions.database_index, 0);
  assert.equal(infra.redis.sessions.in_memory, false);
  assert.deepEqual(infra.redis.sessions.tls_config, { disabled: true });
  assert.equal(infra.redis.sessions.auth.type, "auth_string");
  assert.deepEqual(infra.redis.sessions.auth.auth_string, { $env: "NSTACK_REDIS_PASSWORD" });
  assert.equal(infra.redis.jobs.database_index, 1);
  assert.equal(infra.object_storage[0].type, "s3");
  assert.deepEqual(infra.object_storage[0].access_key_id, { $env: "NSTACK_MINIO_ACCESS_KEY" });
  assert.deepEqual(infra.object_storage[0].secret_access_key, { $env: "NSTACK_MINIO_SECRET_KEY" });
  assert.equal(infra.object_storage[0].endpoint, "http://demo-minio:9000");
  assert.equal(infra.object_storage[0].buckets.uploads.name, "demo-uploads");
  assert.equal(infra.object_storage[0].buckets["public-assets"].public_base_url, "https://demo.example.test/objects/demo-public-assets");
});

test("infra renderer can materialize infrastructure secrets for Encore runtime configs", () => {
  const output = renderEncoreInfra({
    materializeSecrets: true,
    config: {
      app: { slug: "demo", domain: "demo.example.test" },
      deploy: { target: "prod" },
    },
    resources: {
      services: [{ name: "api" }],
      metadata: { gateways: [] },
      databases: [{ name: "app" }],
      topics: [],
      caches: [{ name: "sessions" }],
      buckets: [{ name: "uploads" }],
      secrets: [],
    },
    infra: {
      postgres: {
        host: "demo-postgres:5432",
        database: "app",
        user: "nstack",
        password: "postgres-secret",
      },
      redis: {
        host: "demo-redis:6379",
        password: "redis-secret",
      },
      objectStorage: {
        endpoint: "http://demo-minio:9000",
        region: "us-east-1",
        accessKey: "minio-access",
        secretKey: "minio-secret",
      },
    },
  });

  const infra = JSON.parse(output);
  assert.equal(infra.sql_servers[0].databases.app.password, "postgres-secret");
  assert.equal(infra.redis.sessions.auth.auth_string, "redis-secret");
  assert.equal(infra.object_storage[0].access_key_id, "minio-access");
  assert.equal(infra.object_storage[0].secret_access_key, "minio-secret");
});
