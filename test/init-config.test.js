import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";

test("init keeps deploy target values out of source config", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-init-"));
  const target = path.join(cwd, "app");
  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  try {
    await runCli([
      "init",
      target,
      "--yes",
      "--domain",
      "example.test",
      "--registry",
      "ghcr.io/acme/app",
      "--dokploy-url",
      "https://dokploy.example.test",
      "--dokploy-api-key",
      "secret-token",
    ]);
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const config = readFileSync(path.join(target, "nstack.config.mjs"), "utf8");
  assert.doesNotMatch(config, /NSTACK_REGISTRY|DOKPLOY_URL|DOKPLOY_API_KEY|example\.test|ghcr\.io/);

  const localEnv = readFileSync(path.join(target, ".nstack", "local.env"), "utf8");
  assert.match(localEnv, /NSTACK_DOMAIN=example\.test/);
  assert.match(localEnv, /NSTACK_REGISTRY=ghcr\.io\/acme\/app/);
  assert.match(localEnv, /DOKPLOY_URL=https:\/\/dokploy\.example\.test/);
  assert.match(localEnv, /DOKPLOY_API_KEY=secret-token/);

  const gitignore = readFileSync(path.join(target, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.nstack$/m);
  assert.doesNotMatch(gitignore, /^deploy\/nstack$/m);
  assert.match(gitignore, /^\.env\.\*$/m);

  const dockerignore = readFileSync(path.join(target, "frontend", ".dockerignore"), "utf8");
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^\.env\.\*$/m);

  const rootDockerignore = readFileSync(path.join(target, ".dockerignore"), "utf8");
  assert.match(rootDockerignore, /^\*\*\/node_modules$/m);
  assert.match(rootDockerignore, /^deploy\/nstack$/m);
  assert.match(rootDockerignore, /\.git\/\*\*/);
  assert.match(rootDockerignore, /!\.git\/HEAD/);
  assert.match(rootDockerignore, /!\.git\/packed-refs/);

  const manifest = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.scripts).sort(), ["build", "check", "deploy", "dev", "status"]);
  assert.equal(manifest.scripts.dev, "pnpm --parallel --filter './backend' --filter './frontend' dev");
  assert.equal(manifest.scripts.build, "pnpm --dir frontend build");
  assert.equal(manifest.scripts.check, "node scripts/check.mjs");
  assert.equal(manifest.scripts.deploy, "nstack deploy");
  assert.equal(manifest.scripts.status, "nstack status");

  const generatedConfig = readFileSync(path.join(target, "nstack.config.mjs"), "utf8");
  assert.match(generatedConfig, /frontendContext: "\."/);
  assert.match(generatedConfig, /path: "\/api\/ready"/);

  const frontendDockerfile = readFileSync(path.join(target, "frontend", "Dockerfile"), "utf8");
  assert.match(frontendDockerfile, /COPY pnpm-lock\.yaml \.\//);
  assert.match(frontendDockerfile, /pnpm install --filter \.\/frontend\.\.\./);
  assert.match(frontendDockerfile, /--prefer-offline/);
  assert.match(frontendDockerfile, /--ignore-scripts/);
  assert.match(frontendDockerfile, /\.\/node_modules\/\.bin\/nuxt prepare --logLevel=silent/);
  assert.match(frontendDockerfile, /\.\/node_modules\/\.bin\/nuxt build --logLevel=silent/);
  assert.match(frontendDockerfile, /COPY --from=build \/workspace\/frontend\/\.output \.\/\.output/);
  assert.match(frontendDockerfile, /CMD \["node", "\.output\/server\/index\.mjs"\]/);
  assert.match(frontendDockerfile, /NUXT_TELEMETRY_DISABLED=1/);
  assert.match(frontendDockerfile, /nstack-frontend-nuxt/);
  assert.match(frontendDockerfile, /nstack-frontend-vite/);
  assert.match(frontendDockerfile, /nstack-frontend-jiti/);
  assert.match(frontendDockerfile, /NITRO_PRESET=node-server/);

  const frontendNuxtConfig = readFileSync(path.join(target, "frontend", "nuxt.config.ts"), "utf8");
  assert.match(frontendNuxtConfig, /buildCache: true/);
  assert.match(frontendNuxtConfig, /sourcemap: false/);
  assert.match(frontendNuxtConfig, /reportCompressedSize: false/);
  assert.match(frontendNuxtConfig, /preset: "node-server"/);
  assert.match(frontendNuxtConfig, /sourceMap: false/);

  const frontendManifest = JSON.parse(readFileSync(path.join(target, "frontend", "package.json"), "utf8"));
  assert.equal(frontendManifest.scripts.build, "nuxt build --logLevel=silent");
  assert.equal(frontendManifest.scripts.postinstall, undefined);

  const checkRunner = readFileSync(path.join(target, "scripts", "check.mjs"), "utf8");
  assert.match(checkRunner, /"backend", "exec", "encore", "check", ""/);
  assert.match(checkRunner, /"backend", "exec", "tsc", "--noEmit"/);
  assert.match(checkRunner, /"frontend", "exec", "nuxi", "prepare"/);

  const backendManifest = JSON.parse(readFileSync(path.join(target, "backend", "package.json"), "utf8"));
  assert.equal(backendManifest.scripts.test, "node --test");

  const backendDockerfile = readFileSync(path.join(target, "backend", "Dockerfile"), "utf8");
  assert.match(backendDockerfile, /apt-get install -y --no-install-recommends ca-certificates/);
  assert.match(backendDockerfile, /ENCORE_TELEMETRY_DISABLED=1/);
  assert.match(backendDockerfile, /scripts\/nstack-cron-runner\.mjs/);
  assert.match(backendDockerfile, /encore debug meta -f json > \.encore\/nstack\/meta\.json/);
  assert.match(backendDockerfile, /--outdir=\.encore\/nstack\/cron-runner/);
  assert.match(backendDockerfile, /find \.encore\/nstack -name '\*\.map' -delete/);
  assert.match(backendDockerfile, /ENV RUST_LOG=info/);
  assert.match(backendDockerfile, /COPY --from=build \/workspace\/backend\/\.encore\/nstack\/cron-runner/);
  assert.match(backendDockerfile, /\/encore\/nstack\/git-commit/);
  assert.match(backendDockerfile, /nstack-backend-entrypoint/);
  assert.doesNotMatch(backendDockerfile, /--enable-source-maps/);
  assert.match(backendDockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/nstack-backend-entrypoint"\]/);

  const backendStatus = readFileSync(path.join(target, "backend", "api", "status.ts"), "utf8");
  assert.match(backendStatus, /path: "\/ready"/);

  const cronRunnerScript = readFileSync(path.join(target, "scripts", "nstack-cron-runner.mjs"), "utf8");
  assert.match(cronRunnerScript, /Generated by nstack/);
  assert.match(cronRunnerScript, /NSTACK_CRON_DRAIN_MS/);

  const backendTsconfig = JSON.parse(readFileSync(path.join(target, "backend", "tsconfig.json"), "utf8"));
  assert.equal(backendTsconfig.compilerOptions.module, "ESNext");
  assert.equal(backendTsconfig.compilerOptions.moduleResolution, "Bundler");
});

test("cli flags do not mutate process env while writing local config", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-link-"));
  const target = path.join(cwd, "app");
  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];

  try {
    await runCli(["init", target, "--yes"]);
    const previousCwd = process.cwd();
    process.chdir(target);
    try {
      await runCli([
        "link",
        "--yes",
        "--domain",
        "linked.example.test",
        "--registry",
        "ghcr.io/acme/linked",
        "--dokploy-url",
        "https://dokploy.example.test",
        "--dokploy-api-key",
        "secret-token",
      ]);
    } finally {
      process.chdir(previousCwd);
    }

    for (const key of envKeys) assert.equal(process.env[key], undefined);
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const localEnv = readFileSync(path.join(target, ".nstack", "local.env"), "utf8");
  assert.match(localEnv, /NSTACK_DOMAIN=linked\.example\.test/);
  assert.match(localEnv, /NSTACK_REGISTRY=ghcr\.io\/acme\/linked/);
});

test("configure persists provider-specific source settings non-interactively", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-configure-source-"));
  const target = path.join(cwd, "app");

  await runCli(["init", target, "--yes"]);
  const previousCwd = process.cwd();
  process.chdir(target);
  try {
    await runCli([
      "configure",
      "--yes",
      "--domain",
      "demo.example.test",
      "--dokploy-url",
      "https://dokploy.example.test",
      "--dokploy-api-key",
      "secret-token",
      "--project",
      "Demo Project",
      "--environment",
      "production",
      "--repository",
      "git@git.example.test:acme/demo.git",
      "--branch",
      "main",
      "--source-type",
      "gitea",
      "--gitea-id",
      "gitea-1",
      "--compose-path",
      "deploy/nstack/compose.dokploy.yaml",
      "--watch-paths",
      "backend/**,frontend/**,deploy/nstack/**",
    ]);
  } finally {
    process.chdir(previousCwd);
  }

  const localEnv = readFileSync(path.join(target, ".nstack", "local.env"), "utf8");
  assert.match(localEnv, /NSTACK_DOMAIN=demo\.example\.test/);
  assert.match(localEnv, /DOKPLOY_PROJECT="Demo Project"/);
  assert.match(localEnv, /DOKPLOY_ENVIRONMENT=production/);
  assert.match(localEnv, /NSTACK_REPOSITORY=git@git\.example\.test:acme\/demo\.git/);
  assert.match(localEnv, /NSTACK_BRANCH=main/);
  assert.match(localEnv, /NSTACK_SOURCE_TYPE=gitea/);
  assert.match(localEnv, /NSTACK_GITEA_ID=gitea-1/);
  assert.match(localEnv, /NSTACK_COMPOSE_PATH=deploy\/nstack\/compose\.dokploy\.yaml/);
  assert.match(localEnv, /NSTACK_WATCH_PATHS="backend\/\*\*,frontend\/\*\*,deploy\/nstack\/\*\*"/);
});

test("configure infers provider-backed source settings from Dokploy", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-configure-infer-source-"));
  const target = path.join(cwd, "app");

  await runCli(["init", target, "--yes"]);
  const calls = [];
  const originalFetch = globalThis.fetch;
  const previousCwd = process.cwd();
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname);
    if (parsed.pathname === "/api/trpc/gitProvider.getAll") {
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
    if (parsed.pathname === "/api/trpc/gitea.giteaProviders") return Response.json({ json: [{ giteaId: "gitea-1" }] });
    assert.fail(`Unexpected Dokploy endpoint ${parsed.pathname}`);
  };

  process.chdir(target);
  try {
    await runCli([
      "configure",
      "--yes",
      "--domain",
      "demo.example.test",
      "--dokploy-url",
      "https://dokploy.example.test",
      "--dokploy-api-key",
      "secret-token",
      "--repository",
      "git@git.example.test:acme/demo.git",
      "--branch",
      "main",
    ]);
  } finally {
    process.chdir(previousCwd);
    globalThis.fetch = originalFetch;
  }

  const localEnv = readFileSync(path.join(target, ".nstack", "local.env"), "utf8");
  assert.deepEqual(calls, ["/api/trpc/gitProvider.getAll", "/api/trpc/gitea.giteaProviders"]);
  assert.match(localEnv, /NSTACK_REPOSITORY=git@git\.example\.test:acme\/demo\.git/);
  assert.match(localEnv, /NSTACK_BRANCH=main/);
  assert.match(localEnv, /NSTACK_SOURCE_TYPE=gitea/);
  assert.match(localEnv, /NSTACK_GITEA_ID=gitea-1/);
  assert.match(localEnv, /NSTACK_COMPOSE_PATH=deploy\/nstack\/compose\.dokploy\.yaml/);
});

test("init skips deploy wizard when stdin is not interactive", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-init-nontty-"));
  const target = path.join(cwd, "app");

  const report = await runCli(["init", target]);

  assert.equal(report.files.localEnv, null);
  assert.deepEqual(report.next, [
    "pnpm install",
    "nstack configure --domain <domain> --dokploy-url <url> --dokploy-api-key <key> --repository <git-url>",
    "nstack deploy",
  ]);
});

test("init can write deploy settings for a non-prod target", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-init-target-"));
  const target = path.join(cwd, "app");

  await runCli([
    "init",
    target,
    "--yes",
    "--env",
    "staging",
    "--domain",
    "staging.example.test",
    "--registry",
    "ghcr.io/acme/app-staging",
  ]);

  const config = readFileSync(path.join(target, "nstack.config.mjs"), "utf8");
  const localEnv = readFileSync(path.join(target, ".nstack", "local.staging.env"), "utf8");
  assert.doesNotMatch(config, /staging\.example\.test|ghcr\.io/);
  assert.match(localEnv, /NSTACK_TARGET=staging/);
  assert.match(localEnv, /NSTACK_DOMAIN=staging\.example\.test/);
  assert.match(localEnv, /NSTACK_REGISTRY=ghcr\.io\/acme\/app-staging/);
});

test("init can write provider-specific source settings non-interactively", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-init-source-"));
  const target = path.join(cwd, "app");

  const report = await runCli([
    "init",
    target,
    "--yes",
    "--domain",
    "source.example.test",
    "--dokploy-url",
    "https://dokploy.example.test",
    "--dokploy-api-key",
    "secret-token",
    "--repository",
    "https://gitlab.example.test/platform/apps/source-app.git",
    "--branch",
    "main",
    "--source-type",
    "gitlab",
    "--gitlab-id",
    "gitlab-1",
    "--gitlab-project-id",
    "42",
    "--gitlab-path-namespace",
    "platform/apps/source-app",
    "--watch-paths",
    "backend/**,frontend/**,deploy/nstack/**",
  ]);
  assert.deepEqual(report.next, ["pnpm install", "nstack deploy"]);
  assert.equal(report.deploy.source.type, "gitlab");

  const config = readFileSync(path.join(target, "nstack.config.mjs"), "utf8");
  assert.doesNotMatch(config, /gitlab-1|secret-token|source\.example\.test|gitlab\.example\.test/);

  const localEnv = readFileSync(path.join(target, ".nstack", "local.env"), "utf8");
  assert.match(localEnv, /NSTACK_DOMAIN=source\.example\.test/);
  assert.match(localEnv, /DOKPLOY_URL=https:\/\/dokploy\.example\.test/);
  assert.match(localEnv, /DOKPLOY_API_KEY=secret-token/);
  assert.match(localEnv, /NSTACK_REPOSITORY=https:\/\/gitlab\.example\.test\/platform\/apps\/source-app\.git/);
  assert.match(localEnv, /NSTACK_BRANCH=main/);
  assert.match(localEnv, /NSTACK_SOURCE_TYPE=gitlab/);
  assert.match(localEnv, /NSTACK_GITLAB_ID=gitlab-1/);
  assert.match(localEnv, /NSTACK_GITLAB_PROJECT_ID=42/);
  assert.match(localEnv, /NSTACK_GITLAB_PATH_NAMESPACE=platform\/apps\/source-app/);
  assert.match(localEnv, /NSTACK_WATCH_PATHS="backend\/\*\*,frontend\/\*\*,deploy\/nstack\/\*\*"/);
});

test("init --json reports scaffold metadata without secret values", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-init-json-"));
  const target = path.join(cwd, "app");
  const output = [];
  const originalLog = console.log;

  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli([
      "init",
      target,
      "--yes",
      "--json",
      "--name",
      "Json Init",
      "--domain",
      "json-init.example.test",
      "--registry",
      "ghcr.io/acme/json-init",
      "--dokploy-url",
      "https://dokploy.example.test",
      "--dokploy-api-key",
      "secret-token",
    ]);
    assert.equal(report.app.slug, "json-init");
  } finally {
    console.log = originalLog;
  }

  const json = output.join("\n");
  const report = JSON.parse(json);
  assert.equal(report.app.name, "Json Init");
  assert.equal(report.app.dir, target);
  assert.equal(report.deploy.dokployApiKeySet, true);
  assert.equal(report.deploy.dokployUrl, "https://dokploy.example.test");
  assert.equal(report.files.localEnv, ".nstack/local.env");
  assert.deepEqual(report.localEnv.keys, [
    "DOKPLOY_API_KEY",
    "DOKPLOY_URL",
    "NSTACK_DOMAIN",
    "NSTACK_REGISTRY",
  ]);
  assert.doesNotMatch(json, /secret-token/);
});

test("configure --json reports link metadata without API key values", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-config-json-"));
  const target = path.join(cwd, "app");
  await runCli(["init", target, "--yes"]);

  const output = [];
  const originalLog = console.log;
  const previousCwd = process.cwd();
  process.chdir(target);
  try {
    console.log = (value = "") => output.push(String(value));
    const report = await runCli([
      "configure",
      "--yes",
      "--json",
      "--domain",
      "config-json.example.test",
      "--registry",
      "ghcr.io/acme/config-json",
      "--dokploy-url",
      "https://dokploy.example.test",
      "--dokploy-api-key",
      "secret-token",
      "--project",
      "Config Project",
      "--environment",
      "production",
    ]);
    assert.equal(report.app.slug, "app");
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
  }

  const json = output.join("\n");
  const report = JSON.parse(json);
  assert.equal(report.app.url, "https://config-json.example.test");
  assert.equal(report.deploy.registry, "ghcr.io/acme/config-json");
  assert.equal(report.deploy.dokployApiKeySet, true);
  assert.equal(report.deploy.project, "Config Project");
  assert.equal(report.deploy.environment, "production");
  assert.equal(report.files.localEnv, ".nstack/local.env");
  assert.doesNotMatch(json, /secret-token/);
});
