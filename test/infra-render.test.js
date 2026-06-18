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
