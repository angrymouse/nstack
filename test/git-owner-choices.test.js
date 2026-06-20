import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRepositoryOwnerChoices } from "../src/cli.js";
import { DokployClient, loadDokploySourceProviders } from "../src/providers/dokploy.js";

test("Git owner picker lists current user and creatable organizations", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.host === "dokploy.example.test") {
      const endpoint = parsed.pathname.replace("/api/trpc/", "");
      if (endpoint === "gitProvider.getAll") {
        return Response.json({
          json: [{ providerType: "github", github: { githubId: "github-1", isConfigured: true } }],
        });
      }
      if (endpoint === "github.githubProviders") {
        return Response.json({ json: [{ githubId: "github-1", accessToken: "github-token" }] });
      }
    }
    if (parsed.host === "api.github.com" && parsed.pathname === "/graphql") {
      assert.equal(init.headers.authorization, "Bearer github-token");
      return Response.json({
        data: {
          viewer: {
            login: "nik",
            organizations: {
              nodes: [
                { login: "acme", viewerCanCreateRepositories: true },
                { login: "locked-org", viewerCanCreateRepositories: false },
              ],
            },
          },
        },
      });
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
