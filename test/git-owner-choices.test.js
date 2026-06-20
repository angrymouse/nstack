import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRepositoryOwnerChoices } from "../src/cli.js";
import { DokployClient, loadDokploySourceProviders } from "../src/providers/dokploy.js";

test("Git owner picker lists owners from Dokploy provider repositories", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.host === "dokploy.example.test") {
      const endpoint = parsed.pathname.replace("/api/trpc/", "");
      if (endpoint === "gitProvider.getAll") {
        return Response.json({
          json: [{ providerType: "github", github: { githubId: "github-1", username: "nik", isConfigured: true } }],
        });
      }
      if (endpoint === "github.githubProviders") {
        return Response.json({ json: [{ githubId: "github-1" }] });
      }
      if (endpoint === "github.getGithubRepositories") {
        const input = JSON.parse(parsed.searchParams.get("input"));
        assert.deepEqual(input, { json: { githubId: "github-1" } });
        return Response.json({
          json: [
            { name: "api", full_name: "acme/api", owner: { login: "acme" } },
            { name: "app", full_name: "nik/app", owner: { login: "nik" } },
            { name: "web", full_name: "acme/web", owner: { login: "acme" } },
          ],
        });
      }
    }
    assert.fail(`Unexpected request ${parsed.href}`);
  };

  try {
    const client = new DokployClient({ url: "https://dokploy.example.test", apiKey: "dokploy-token" });
    const [provider] = await loadDokploySourceProviders(client);
    const choices = await loadRepositoryOwnerChoices({
      sourceType: "github",
      host: "github.com",
      provider,
    });
    assert.deepEqual(choices.map((choice) => choice.value), ["nik", "acme"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gitea owner picker uses Dokploy repository listings", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.host !== "dokploy.example.test") assert.fail(`Unexpected request ${parsed.href}`);
    const endpoint = parsed.pathname.replace("/api/trpc/", "");
    if (endpoint === "gitProvider.getAll") {
      return Response.json({
        json: [{ providerType: "gitea", gitea: { giteaId: "gitea-1", giteaUrl: "https://git.example.test", isConfigured: true } }],
      });
    }
    if (endpoint === "gitea.giteaProviders") return Response.json({ json: [{ giteaId: "gitea-1" }] });
    if (endpoint === "gitea.getGiteaRepositories") {
      const input = JSON.parse(parsed.searchParams.get("input"));
      assert.deepEqual(input, { json: { giteaId: "gitea-1" } });
      return Response.json({
        json: [
          { name: "nstack", url: "angrymouse/nstack", owner: { username: "angrymouse" } },
          { name: "polyedge", url: "polyedge/polyedge", owner: { username: "polyedge" } },
          { name: "scpm", url: "scpm/scpm", owner: { username: "scpm" } },
        ],
      });
    }
    assert.fail(`Unexpected Dokploy endpoint ${endpoint}`);
  };

  try {
    const client = new DokployClient({ url: "https://dokploy.example.test", apiKey: "dokploy-token" });
    const [provider] = await loadDokploySourceProviders(client);
    const choices = await loadRepositoryOwnerChoices({
      sourceType: "gitea",
      host: "git.example.test",
      provider,
    }, { host: "git.example.test", owner: "polyedge", repository: "polyedge" }, { includePublicFallback: false });
    assert.deepEqual(choices.map((choice) => choice.value), ["angrymouse", "polyedge", "scpm"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gitea owner picker falls back to validated local user and public orgs without provider token", async () => {
  const originalFetch = globalThis.fetch;
  const originalUser = process.env.USER;
  const tokenEnv = ["NSTACK_GIT_ACCESS_TOKEN", "GITEA_TOKEN", "FORGEJO_TOKEN"];
  const originalTokens = Object.fromEntries(tokenEnv.map((key) => [key, process.env[key]]));

  process.env.USER = "nik";
  for (const key of tokenEnv) delete process.env[key];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v1/users/nik") {
      return Response.json({ login: "nik" });
    }
    if (parsed.pathname.startsWith("/api/v1/users/")) {
      return Response.json({ message: "not found" }, { status: 404 });
    }
    if (parsed.pathname === "/api/v1/repos/search") {
      return Response.json({
        ok: true,
        data: [
          { name: "nstack", full_name: "angrymouse/nstack", owner: { login: "angrymouse" } },
          { name: "polyedge", full_name: "polyedge/polyedge", owner: { username: "polyedge" } },
        ],
      });
    }
    if (parsed.pathname === "/api/v1/orgs") {
      return Response.json([
        { username: "acme" },
        { name: "platform" },
      ]);
    }
    assert.fail(`Unexpected request ${parsed.href}`);
  };

  try {
    const choices = await loadRepositoryOwnerChoices({
      sourceType: "gitea",
      host: "git.example.test",
      provider: {
        providerType: "gitea",
        gitea: { giteaId: "gitea-1", giteaUrl: "https://git.example.test" },
      },
    });
    assert.deepEqual(choices.map((choice) => choice.value), ["nik", "angrymouse", "polyedge", "acme", "platform"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUser === undefined) delete process.env.USER;
    else process.env.USER = originalUser;
    for (const key of tokenEnv) {
      if (originalTokens[key] === undefined) delete process.env[key];
      else process.env[key] = originalTokens[key];
    }
  }
});
