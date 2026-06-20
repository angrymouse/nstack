import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DOKPLOY_REDIS_ARGS,
  DOKPLOY_REDIS_COMMAND,
  DOKPLOY_REDIS_IMAGE,
  DokployProvider,
  ensureGiteaComposeWebhook,
  expectedComposeDomains,
} from "../src/providers/dokploy.js";

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

test("ensureRedis creates a Dokploy-native Dragonfly cache resource", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || "GET", path: parsed.pathname, body });

    if ((init.method || "GET") === "GET" && parsed.pathname === "/api/trpc/redis.search") {
      return Response.json({ json: [] });
    }
    if (init.method === "POST" && parsed.pathname === "/api/redis.create") {
      return Response.json({ json: { redisId: "redis-1" } });
    }
    if ((init.method || "GET") === "GET" && parsed.pathname === "/api/redis.one") {
      return Response.json({ json: { redisId: "redis-1", appName: "cache-app-redis-a1b2c3" } });
    }
    return Response.json({ json: {} });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "cache-app" },
        deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy", serverId: "server-1" } },
      },
      state: { dokploy: {} },
    });
    const redisId = await provider.ensureRedis("environment-1", {
      redis: { password: "secret-password" },
    });
    assert.equal(redisId, "redis-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const create = calls.find((call) => call.path === "/api/redis.create");
  assert.equal(create.body.name, "cache-app-redis");
  assert.equal(create.body.appName, "cache-app-redis");
  assert.equal(create.body.dockerImage, DOKPLOY_REDIS_IMAGE);
  assert.equal(create.body.environmentId, "environment-1");
  assert.equal(create.body.serverId, "server-1");
  assert.match(create.body.description, /Dragonfly/);

  const update = calls.find((call) => call.path === "/api/redis.update");
  assert.equal(update.body.redisId, "redis-1");
  assert.equal(update.body.name, "cache-app-redis");
  assert.equal(update.body.appName, "cache-app-redis-a1b2c3");
  assert.equal(update.body.dockerImage, DOKPLOY_REDIS_IMAGE);
  assert.equal(update.body.databasePassword, "secret-password");
  assert.equal(update.body.command, DOKPLOY_REDIS_COMMAND);
  assert.deepEqual(update.body.args, [...DOKPLOY_REDIS_ARGS, "--requirepass", "secret-password"]);
  assert.equal(update.body.env, "REDIS_PASSWORD=secret-password\n");

  const deploy = calls.find((call) => call.path === "/api/redis.deploy");
  assert.deepEqual(deploy.body, { redisId: "redis-1" });
});

test("ensurePostgres and ensureRedis reuse existing Dokploy resources by name", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || "GET", path: parsed.pathname, body });

    if ((init.method || "GET") === "GET" && parsed.pathname === "/api/trpc/postgres.search") {
      return Response.json({ json: [{ postgresId: "postgres-1", name: "reuse-app-postgres" }] });
    }
    if ((init.method || "GET") === "GET" && parsed.pathname === "/api/trpc/redis.search") {
      return Response.json({ json: [{ redisId: "redis-1", name: "reuse-app-redis" }] });
    }
    return Response.json({ json: {} });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "reuse-app" },
        deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy" } },
      },
      state: { dokploy: {} },
    });
    assert.equal(await provider.ensurePostgres("environment-1", {
      postgres: { database: "app", user: "nstack", password: "postgres-secret" },
    }), "postgres-1");
    assert.equal(await provider.ensureRedis("environment-1", {
      redis: { password: "redis-secret" },
    }), "redis-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.some((call) => call.path === "/api/postgres.create"), false);
  assert.equal(calls.some((call) => call.path === "/api/redis.create"), false);
  assert.equal(calls.some((call) => call.path === "/api/postgres.deploy"), false);
  assert.equal(calls.some((call) => call.path === "/api/redis.deploy"), false);
});

test("expected Compose domains include object storage route only for public buckets", () => {
  const config = { app: { domain: "bucket.example.test" } };
  assert.deepEqual(
    expectedComposeDomains(config, "compose-1", { buckets: [{ name: "private" }] }).map((domain) => domain.path),
    ["/", "/api"],
  );
  assert.deepEqual(
    expectedComposeDomains(config, "compose-1", { buckets: [{ name: "public-assets", public: true }] }).map((domain) => `${domain.path}:${domain.serviceName}:${domain.port}:${domain.stripPath}`),
    ["/:frontend:3000:false", "/api:backend:8080:true", "/objects:rustfs-public:9000:true"],
  );
});

test("ensureDomains prunes stale managed routes before adding replacements", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || "GET", path: parsed.pathname, body });
    if ((init.method || "GET") === "GET" && parsed.pathname === "/api/domain.byComposeId") {
      return Response.json({
        json: [
          { domainId: "domain-home", host: "bucket.example.test", path: "/", serviceName: "frontend", port: 3000, stripPath: false },
          { domainId: "domain-api", host: "bucket.example.test", path: "/api", serviceName: "backend", port: 8080, stripPath: true },
          { domainId: "domain-old-objects", host: "bucket.example.test", path: "/objects", serviceName: "rustfs", port: 9000, stripPath: true },
          { domainId: "domain-custom", host: "custom.example.test", path: "/objects", serviceName: "minio", port: 9000, stripPath: true },
        ],
      });
    }
    return Response.json({ json: body?.domainId ? {} : { domainId: "created-domain" } });
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "bucket-app", domain: "bucket.example.test" },
        deploy: { provider: { url: "https://dokploy.example.test", apiKey: "dummy" } },
      },
      state: { dokploy: {} },
    });
    await provider.ensureDomains("compose-1", { buckets: [{ name: "public-assets", public: true }] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const deletes = calls.filter((call) => call.path === "/api/domain.delete");
  assert.deepEqual(deletes.map((call) => call.body.domainId), ["domain-old-objects"]);
  const creates = calls.filter((call) => call.path === "/api/domain.create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].body.path, "/objects");
  assert.equal(creates[0].body.serviceName, "rustfs-public");
});

test("upsertCompose falls back to compose.update when saveEnvironment is unavailable", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, body });

    if (parsed.pathname === "/api/compose.one") {
      return Response.json({ json: { composeId: "compose-1" } });
    }
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
    if (parsed.pathname === "/api/compose.one") {
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

test("upsertCompose ensures Gitea webhook when compose id is already saved", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ host: parsed.host, method: init.method || "GET", path: parsed.pathname, body });
    if (parsed.host === "git.example.test" && (init.method || "GET") === "GET") return Response.json([]);
    if (parsed.host === "git.example.test" && init.method === "POST") return Response.json({ id: 12 });
    if (parsed.pathname === "/api/compose.one") {
      return Response.json({
        json: {
          composeId: "compose-1",
          refreshToken: "refresh-1",
          gitea: {
            giteaUrl: "https://git.example.test",
            accessToken: "token-1",
          },
        },
      });
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

  assert.ok(calls.some((call) => call.host === "dokploy.example.test" && call.path === "/api/compose.one"));
  const createdHook = calls.find((call) => call.host === "git.example.test" && call.method === "POST");
  assert.equal(createdHook.path, "/api/v1/repos/acme/source-app/hooks");
  assert.equal(createdHook.body.config.url, "https://dokploy.example.test/api/deploy/compose/refresh-1");
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
      if (parsed.pathname === "/api/compose.one") {
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
  const providers = [
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
        isConfigured: false,
      },
    },
  ];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace("/api/trpc/", "");
    if (endpoint === "gitProvider.getAll") return Response.json({ json: providers });
    if (endpoint === "github.githubProviders") return Response.json({ json: [{ githubId: "github-1" }] });
    if (endpoint === "gitlab.gitlabProviders") return Response.json({ json: [{ gitlabId: "gitlab-1" }] });
    if (endpoint === "bitbucket.bitbucketProviders") return Response.json({ json: [{ bitbucketId: "bitbucket-1" }] });
    if (endpoint === "gitea.giteaProviders") return Response.json({ json: [{ giteaId: "gitea-1" }] });
    assert.fail(`Unexpected Dokploy endpoint ${endpoint}`);
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

test("resolveComposeSource rejects unconfigured Dokploy git providers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const endpoint = parsed.pathname.replace("/api/trpc/", "");
    if (endpoint === "gitProvider.getAll") {
      return Response.json({
        json: [
          {
            providerType: "gitea",
            gitea: {
              giteaId: "gitea-1",
              giteaUrl: "https://git.example.test",
              isConfigured: false,
            },
          },
        ],
      });
    }
    if (endpoint === "gitea.giteaProviders") return Response.json({ json: [] });
    assert.fail(`Unexpected Dokploy endpoint ${endpoint}`);
  };

  try {
    const provider = new DokployProvider({
      config: {
        app: { slug: "compose-app" },
        deploy: {
          source: {
            sourceType: "gitea",
            giteaId: "gitea-1",
            repository: "git@git.example.test:acme/source-app.git",
            branch: "main",
          },
          provider: { url: "https://dokploy.example.test", apiKey: "dummy" },
        },
      },
      state: { dokploy: {} },
    });

    await assert.rejects(
      () => provider.resolveComposeSource(),
      /Dokploy gitea provider id gitea-1 is not configured for source-backed Compose/,
    );
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

test("ensureGiteaComposeWebhook creates a missing Forgejo webhook", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || "GET", path: parsed.pathname, body, authorization: init.headers?.authorization });
    if ((init.method || "GET") === "GET") return Response.json([]);
    return Response.json({ id: 10 });
  };

  try {
    const result = await ensureGiteaComposeWebhook({
      dokployUrl: "https://dokploy.example.test",
      compose: {
        refreshToken: "refresh-1",
        gitea: {
          giteaUrl: "https://git.example.test/",
          accessToken: "token-1",
        },
      },
      source: {
        owner: "acme",
        repository: "source-app",
      },
    });
    assert.deepEqual(result, {
      created: true,
      hookUrl: "https://dokploy.example.test/api/deploy/compose/refresh-1",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.map((call) => [call.method, call.path]), [
    ["GET", "/api/v1/repos/acme/source-app/hooks"],
    ["POST", "/api/v1/repos/acme/source-app/hooks"],
  ]);
  assert.equal(calls[0].authorization, "token token-1");
  assert.equal(calls[1].body.type, "gitea");
  assert.equal(calls[1].body.config.url, "https://dokploy.example.test/api/deploy/compose/refresh-1");
  assert.equal(calls[1].body.config.content_type, "json");
  assert.deepEqual(calls[1].body.events, ["push"]);
  assert.equal(calls[1].body.active, true);
});

test("ensureGiteaComposeWebhook keeps an existing Forgejo webhook", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ method: init.method || "GET", path: parsed.pathname });
    return Response.json([
      {
        id: 10,
        config: {
          url: "https://dokploy.example.test/api/deploy/compose/refresh-1",
        },
      },
    ]);
  };

  try {
    const result = await ensureGiteaComposeWebhook({
      dokployUrl: "https://dokploy.example.test/",
      compose: {
        refreshToken: "refresh-1",
        gitea: {
          giteaUrl: "https://git.example.test",
          accessToken: "token-1",
        },
      },
      source: {
        owner: "acme",
        repository: "source-app",
      },
    });
    assert.deepEqual(result, {
      created: false,
      hookUrl: "https://dokploy.example.test/api/deploy/compose/refresh-1",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [{ method: "GET", path: "/api/v1/repos/acme/source-app/hooks" }]);
});

test("ensureGiteaComposeWebhook tells users to create and push missing Forgejo repos", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    message: "The target couldn't be found.",
    url: "https://git.example.test/api/swagger",
    errors: [],
  }, { status: 404 });

  try {
    await assert.rejects(
      ensureGiteaComposeWebhook({
        dokployUrl: "https://dokploy.example.test/",
        compose: {
          refreshToken: "refresh-1",
          gitea: {
            giteaUrl: "https://git.example.test",
            accessToken: "token-1",
          },
        },
        source: {
          owner: "acme",
          repository: "source-app",
          branch: "main",
        },
      }),
      (error) => {
        assert.match(error.message, /Gitea repository acme\/source-app was not found/);
        assert.match(error.message, /Create a private repository in Gitea\/Forgejo and push this app before deploying/);
        assert.match(error.message, /git remote add origin https:\/\/git\.example\.test\/acme\/source-app\.git/);
        assert.match(error.message, /git commit -m "init"/);
        assert.match(error.message, /git push -u origin main/);
        assert.doesNotMatch(error.message, /token-1/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
