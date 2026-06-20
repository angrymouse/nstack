import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  loadDokployInstances,
  promptDokployInstance,
  saveDokployInstance,
} from "../src/dokploy-instances.js";

test("Dokploy instance picker selects saved instances without exposing API keys", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-dokploy-instances-"));
  const file = path.join(cwd, "instances.json");
  const envKeys = ["DOKPLOY_URL", "DOKPLOY_API_KEY", "NSTACK_DOKPLOY_INSTANCE", "NSTACK_DOKPLOY_INSTANCE_NAME"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];

  try {
    saveDokployInstance({ name: "Production", url: "https://dokploy.example.test/", apiKey: "secret-token" }, file);

    const picked = await promptDokployInstance({
      yes: false,
      async select(name, message, choices) {
        assert.equal(name, "NSTACK_DOKPLOY_INSTANCE");
        assert.equal(message, "Dokploy instance");
        assert.deepEqual(choices.map((choice) => choice.label), [
          "Production (https://dokploy.example.test)",
          "Add new",
        ]);
        assert.doesNotMatch(choices.map((choice) => choice.label).join("\n"), /secret-token/);
        return choices[0];
      },
      async ask() {
        assert.fail("Selecting a saved instance should not ask for credentials.");
      },
      async askOptional() {
        assert.fail("Selecting a saved instance should not ask for a name.");
      },
    }, { file });

    assert.deepEqual(picked, {
      name: "Production",
      url: "https://dokploy.example.test",
      apiKey: "secret-token",
    });
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test("Dokploy instance picker can add and persist a new instance", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-dokploy-add-instance-"));
  const file = path.join(cwd, "instances.json");
  const envKeys = ["DOKPLOY_URL", "DOKPLOY_API_KEY", "NSTACK_DOKPLOY_INSTANCE", "NSTACK_DOKPLOY_INSTANCE_NAME"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];

  try {
    const added = await promptDokployInstance({
      yes: false,
      async select(name, message, choices) {
        assert.equal(name, "NSTACK_DOKPLOY_INSTANCE");
        assert.equal(message, "Dokploy instance");
        assert.deepEqual(choices.map((choice) => choice.label), ["Add new"]);
        return choices[0];
      },
      async ask(name) {
        if (name === "DOKPLOY_URL") return "dokploy-added.example.test/";
        if (name === "DOKPLOY_API_KEY") return "added-token";
        assert.fail(`Unexpected required prompt ${name}`);
      },
      async askOptional(name, message, { defaultValue }) {
        assert.equal(name, "NSTACK_DOKPLOY_INSTANCE_NAME");
        assert.equal(message, "Dokploy instance name");
        assert.equal(defaultValue, "dokploy-added.example.test");
        return "Added";
      },
    }, { file });

    assert.deepEqual(added, {
      name: "Added",
      url: "https://dokploy-added.example.test",
      apiKey: "added-token",
    });
    assert.deepEqual(loadDokployInstances(file), [added]);
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});
