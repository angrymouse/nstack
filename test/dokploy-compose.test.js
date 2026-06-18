import assert from "node:assert/strict";
import { test } from "node:test";
import { DokployProvider } from "../src/providers/dokploy.js";

test("upsertCompose saves Compose env with Dokploy environment endpoint", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, body });

    if (init.method === "GET" && parsed.pathname === "/api/trpc/compose.search") {
      return Response.json({ json: [] });
    }
    if (init.method === "POST" && parsed.pathname === "/api/compose.create") {
      return Response.json({ json: { composeId: "compose-1" } });
    }
    return Response.json({ json: {} });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "compose-app" },
        deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy" } },
      },
      state: { dokploy: {} },
    });
    const composeId = await provider.upsertCompose("environment-1", "services: {}", "API_SECRET=one\n");
    assert.equal(composeId, "compose-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const create = calls.find((call) => call.path === "/api/compose.create");
  assert.equal(create.body.env, undefined);

  const save = calls.find((call) => call.path === "/api/compose.saveEnvironment");
  assert.deepEqual(save.body, { composeId: "compose-1", env: "API_SECRET=one\n" });
});

test("upsertCompose falls back to compose.update when saveEnvironment is unavailable", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, body });

    if (parsed.pathname === "/api/compose.saveEnvironment") {
      return Response.json({ code: "NOT_FOUND", message: "Not found" }, { status: 404 });
    }
    return Response.json({ json: {} });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "compose-app" },
        deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy" } },
      },
      state: { dokploy: { composeId: "compose-1" } },
    });
    const composeId = await provider.upsertCompose("environment-1", "services: {}", "API_SECRET=two\n");
    assert.equal(composeId, "compose-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const updates = calls.filter((call) => call.path === "/api/compose.update");
  assert.equal(updates.length, 2);
  assert.equal(updates[0].body.composeFile, "services: {}");
  assert.deepEqual(updates[1].body, { composeId: "compose-1", env: "API_SECRET=two\n" });
});

test("upsertCompose can save a Gitea source-backed Compose app for push deploys", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, body });
    return Response.json({ json: {} });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "compose-app" },
        deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy" } },
      },
      state: { dokploy: { composeId: "compose-1" } },
    });
    await provider.upsertCompose("environment-1", "services: {}", "API_SECRET=two\n", {
      source: {
        sourceType: "gitea",
        giteaId: "gitea-1",
        owner: "acme",
        repository: "source-app",
        branch: "main",
        composePath: "deploy/nstack/compose.dokploy.yaml",
        watchPaths: [],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const update = calls.find((call) => call.path === "/api/compose.update");
  assert.equal(update.body.sourceType, "gitea");
  assert.equal(update.body.giteaId, "gitea-1");
  assert.equal(update.body.giteaOwner, "acme");
  assert.equal(update.body.giteaRepository, "source-app");
  assert.equal(update.body.giteaBranch, "main");
  assert.equal(update.body.composePath, "deploy/nstack/compose.dokploy.yaml");
  assert.equal(update.body.autoDeploy, true);
  assert.equal(update.body.triggerType, "push");
});

test("upsertCompose saves provider-specific source fields", async () => {
  const sources = [
    {
      source: {
        sourceType: "github",
        githubId: "github-1",
        owner: "acme",
        repository: "source-app",
        branch: "main",
        composePath: "deploy/nstack/compose.dokploy.yaml",
        watchPaths: ["frontend/**"],
      },
      expected: {
        sourceType: "github",
        githubId: "github-1",
        owner: "acme",
        repository: "source-app",
        branch: "main",
        watchPaths: ["frontend/**"],
      },
    },
    {
      source: {
        sourceType: "gitlab",
        gitlabId: "gitlab-1",
        owner: "platform",
        repository: "source-app",
        branch: "main",
        gitlabProjectId: 123,
        gitlabPathNamespace: "platform/apps/source-app",
        composePath: "deploy/nstack/compose.dokploy.yaml",
        watchPaths: [],
      },
      expected: {
        sourceType: "gitlab",
        gitlabId: "gitlab-1",
        gitlabOwner: "platform",
        gitlabRepository: "source-app",
        gitlabBranch: "main",
        gitlabProjectId: 123,
        gitlabPathNamespace: "platform/apps/source-app",
      },
    },
    {
      source: {
        sourceType: "bitbucket",
        bitbucketId: "bitbucket-1",
        owner: "acme",
        repository: "Source App",
        branch: "main",
        bitbucketRepositorySlug: "source-app",
        composePath: "deploy/nstack/compose.dokploy.yaml",
        watchPaths: [],
      },
      expected: {
        sourceType: "bitbucket",
        bitbucketId: "bitbucket-1",
        bitbucketOwner: "acme",
        bitbucketRepository: "Source App",
        bitbucketRepositorySlug: "source-app",
        bitbucketBranch: "main",
      },
    },
    {
      source: {
        sourceType: "git",
        owner: "acme",
        repository: "source-app",
        repositoryUrl: "git@git.example.test:acme/source-app.git",
        branch: "main",
        sshKeyId: "ssh-key-1",
        composePath: "deploy/nstack/compose.dokploy.yaml",
        watchPaths: [],
      },
      expected: {
        sourceType: "git",
        customGitUrl: "git@git.example.test:acme/source-app.git",
        customGitBranch: "main",
        customGitSSHKeyId: "ssh-key-1",
      },
    },
  ];

  for (const { source, expected } of sources) {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(String(url));
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ method: init.method, path: parsed.pathname, body });
      return Response.json({ json: {} });
    };

    try {
      const provider = new DokployProvider({
        config: {
          app: { slug: "compose-app" },
          deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy" } },
        },
        state: { dokploy: { composeId: "compose-1" } },
      });
      await provider.upsertCompose("environment-1", "services: {}", "API_SECRET=two\n", { source });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const update = calls.find((call) => call.path === "/api/compose.update");
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(update.body[key], value);
    assert.equal(update.body.composePath, "deploy/nstack/compose.dokploy.yaml");
    if (source.sourceType !== "git") {
      assert.equal(update.body.autoDeploy, true);
      assert.equal(update.body.triggerType, "push");
    }
  }
});

test("resolveComposeSource matches repositories to Dokploy git providers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, "/api/trpc/gitProvider.getAll");
    return Response.json({
      json: [
        {
          providerType: "github",
          github: {
            githubId: "github-1",
          },
        },
        {
          providerType: "gitlab",
          gitlab: {
            gitlabId: "gitlab-1",
            gitlabUrl: "https://gitlab.example.test",
          },
        },
        {
          providerType: "bitbucket",
          bitbucket: {
            bitbucketId: "bitbucket-1",
          },
        },
        {
          providerType: "gitea",
          gitea: {
            giteaId: "gitea-1",
            giteaUrl: "https://git.example.test",
          },
        },
      ],
    });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "compose-app" },
        deploy: {
          source: {
            repository: "git@git.example.test:acme/source-app.git",
            branch: "main",
          },
          provider: { url: "https://dokploy.example.test", apiKey: "dummy" },
        },
      },
      state: { dokploy: {} },
    });
    const source = await provider.resolveComposeSource();
    assert.deepEqual(source, {
      sourceType: "gitea",
      giteaId: "gitea-1",
      owner: "acme",
      repository: "source-app",
      branch: "main",
      pathNamespace: "acme/source-app",
      gitlabProjectId: "",
      gitlabPathNamespace: "acme/source-app",
      bitbucketRepositorySlug: "source-app",
      composePath: "deploy/nstack/compose.dokploy.yaml",
      watchPaths: [],
      refLabel: "acme/source-app@main",
    });

    const github = new DokployProvider({
      config: {
        app: { slug: "compose-app" },
        deploy: {
          source: {
            repository: "https://github.com/acme/github-app.git",
            branch: "main",
          },
          provider: { url: "https://dokploy.example.test", apiKey: "dummy" },
        },
      },
      state: { dokploy: {} },
    });
    assert.deepEqual(await github.resolveComposeSource(), {
      sourceType: "github",
      githubId: "github-1",
      owner: "acme",
      repository: "github-app",
      branch: "main",
      pathNamespace: "acme/github-app",
      gitlabProjectId: "",
      gitlabPathNamespace: "acme/github-app",
      bitbucketRepositorySlug: "github-app",
      composePath: "deploy/nstack/compose.dokploy.yaml",
      watchPaths: [],
      refLabel: "acme/github-app@main",
    });

    const gitlab = new DokployProvider({
      config: {
        app: { slug: "compose-app" },
        deploy: {
          source: {
            repository: "https://gitlab.example.test/platform/apps/gitlab-app.git",
            branch: "main",
            gitlabProjectId: 321,
          },
          provider: { url: "https://dokploy.example.test", apiKey: "dummy" },
        },
      },
      state: { dokploy: {} },
    });
    assert.deepEqual(await gitlab.resolveComposeSource(), {
      sourceType: "gitlab",
      gitlabId: "gitlab-1",
      owner: "platform",
      repository: "gitlab-app",
      branch: "main",
      pathNamespace: "platform/apps/gitlab-app",
      gitlabProjectId: 321,
      gitlabPathNamespace: "platform/apps/gitlab-app",
      bitbucketRepositorySlug: "gitlab-app",
      composePath: "deploy/nstack/compose.dokploy.yaml",
      watchPaths: [],
      refLabel: "platform/apps/gitlab-app@main",
    });

    const bitbucket = new DokployProvider({
      config: {
        app: { slug: "compose-app" },
        deploy: {
          source: {
            repository: "https://bitbucket.org/acme/bitbucket-app.git",
            branch: "main",
          },
          provider: { url: "https://dokploy.example.test", apiKey: "dummy" },
        },
      },
      state: { dokploy: {} },
    });
    assert.deepEqual(await bitbucket.resolveComposeSource(), {
      sourceType: "bitbucket",
      bitbucketId: "bitbucket-1",
      owner: "acme",
      repository: "bitbucket-app",
      branch: "main",
      pathNamespace: "acme/bitbucket-app",
      gitlabProjectId: "",
      gitlabPathNamespace: "acme/bitbucket-app",
      bitbucketRepositorySlug: "bitbucket-app",
      composePath: "deploy/nstack/compose.dokploy.yaml",
      watchPaths: [],
      refLabel: "acme/bitbucket-app@main",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveComposeSource supports explicit plain Git source mode", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, "/api/trpc/gitProvider.getAll");
    return Response.json({ json: [] });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "compose-app" },
        deploy: {
          source: {
            sourceType: "git",
            repository: "git@git.example.test:acme/source-app.git",
            branch: "main",
            sshKeyId: "ssh-key-1",
          },
          provider: { url: "https://dokploy.example.test", apiKey: "dummy" },
        },
      },
      state: { dokploy: {} },
    });
    assert.deepEqual(await provider.resolveComposeSource(), {
      sourceType: "git",
      owner: "acme",
      repository: "source-app",
      repositoryUrl: "git@git.example.test:acme/source-app.git",
      branch: "main",
      sshKeyId: "ssh-key-1",
      composePath: "deploy/nstack/compose.dokploy.yaml",
      watchPaths: [],
      refLabel: "acme/source-app@main",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
