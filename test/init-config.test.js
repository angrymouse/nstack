import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";
import { saveDokployInstance } from "../src/dokploy-instances.js";

test("init keeps deploy target values out of source config", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-init-"));
  const target = path.join(cwd, "app");
  const fakeBin = path.join(cwd, "bin");
  const pnpmLog = path.join(cwd, "pnpm.log");
  const envKeys = ["NSTACK_DOMAIN", "NSTACK_REGISTRY", "DOKPLOY_URL", "DOKPLOY_API_KEY"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalPath = process.env.PATH;
  const originalFakePnpmLog = process.env.NSTACK_FAKE_PNPM_LOG;
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(path.join(fakeBin, "pnpm"), `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  printf '10.33.2\\n'
  exit 0
fi
if [ "$1" = "help" ] && [ "$2" = "approve-builds" ]; then
  printf '      --all                Approve all pending dependencies without interactive prompts\\n'
  exit 0
fi
printf '%s\\n' "$*" >> "$NSTACK_FAKE_PNPM_LOG"
if [ "$1" = "install" ]; then
  printf 'lockfileVersion: "9.0"\\n' > pnpm-lock.yaml
  exit 0
fi
if [ "$1" = "approve-builds" ] && [ "$2" = "--all" ]; then
  printf '\\nonlyBuiltDependencies:\\n  - esbuild\\n  - "@parcel/watcher"\\n' >> pnpm-workspace.yaml
  exit 0
fi
exit 1
`);
  chmodSync(path.join(fakeBin, "pnpm"), 0o755);

  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    process.env.NSTACK_FAKE_PNPM_LOG = pnpmLog;
    const report = await runCli([
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
    assert.equal(report.install.skipped, false);
    assert.deepEqual(report.install.commands, ["pnpm install --no-frozen-lockfile", "pnpm approve-builds --all"]);
    assert.deepEqual(report.next, [
      `cd ${target}`,
      "nstack configure --domain <domain> --dokploy-url <url> --dokploy-api-key <key> --repository <git-url>",
      "nstack deploy",
    ]);
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalFakePnpmLog === undefined) delete process.env.NSTACK_FAKE_PNPM_LOG;
    else process.env.NSTACK_FAKE_PNPM_LOG = originalFakePnpmLog;
  }

  const config = readFileSync(path.join(target, "nstack.config.mjs"), "utf8");
  assert.doesNotMatch(config, /NSTACK_REGISTRY|DOKPLOY_URL|DOKPLOY_API_KEY|example\.test|ghcr\.io/);

  const localEnv = readFileSync(path.join(target, ".nstack", "local.env"), "utf8");
  assert.match(localEnv, /NSTACK_DOMAIN=example\.test/);
  assert.match(localEnv, /NSTACK_REGISTRY=ghcr\.io\/acme\/app/);
  assert.match(localEnv, /DOKPLOY_URL=https:\/\/dokploy\.example\.test/);
  assert.match(localEnv, /DOKPLOY_API_KEY=secret-token/);

  assert.equal(execFileSync("git", ["-C", target, "log", "-1", "--pretty=%s"], { encoding: "utf8" }).trim(), "init");
  assert.equal(execFileSync("git", ["-C", target, "branch", "--show-current"], { encoding: "utf8" }).trim(), "main");
  assert.equal(execFileSync("git", ["-C", target, "status", "--short"], { encoding: "utf8" }).trim(), "");
  assert.deepEqual(readFileSync(pnpmLog, "utf8").trim().split("\n"), ["install --no-frozen-lockfile", "approve-builds --all"]);
  assert.equal(execFileSync("git", ["-C", target, "ls-tree", "-r", "--name-only", "HEAD", "pnpm-lock.yaml"], { encoding: "utf8" }).trim(), "pnpm-lock.yaml");
  assert.equal(execFileSync("git", ["-C", target, "ls-tree", "-r", "--name-only", "HEAD", "frontend/app/generated/encore-client.ts"], { encoding: "utf8" }).trim(), "frontend/app/generated/encore-client.ts");
  assert.equal(execFileSync("git", ["-C", target, "ls-tree", "-r", "--name-only", "HEAD", "backend/.gitignore"], { encoding: "utf8" }).trim(), "backend/.gitignore");
  assert.equal(execFileSync("git", ["-C", target, "ls-tree", "-r", "--name-only", "HEAD", "AGENTS.md"], { encoding: "utf8" }).trim(), "AGENTS.md");
  assert.equal(execFileSync("git", ["-C", target, "ls-tree", "-r", "--name-only", "HEAD", "CLAUDE.md"], { encoding: "utf8" }).trim(), "CLAUDE.md");
  assert.equal(execFileSync("git", ["-C", target, "ls-tree", "-r", "--name-only", "HEAD", "NSTACK_GUIDELINES.md"], { encoding: "utf8" }).trim(), "NSTACK_GUIDELINES.md");
  assert.equal(lstatSync(path.join(target, "CLAUDE.md")).isSymbolicLink(), true);
  assert.equal(readlinkSync(path.join(target, "CLAUDE.md")), "AGENTS.md");
  assert.match(readFileSync(path.join(target, "AGENTS.md"), "utf8"), /NSTACK_GUIDELINES\.md/);
  assert.match(readFileSync(path.join(target, "pnpm-workspace.yaml"), "utf8"), /onlyBuiltDependencies:/);
  assert.equal(existsSync(path.join(target, "backend", "node_modules")), false);
  assert.equal(existsSync(path.join(target, "backend", ".encore")), false);
  assert.equal(existsSync(path.join(target, "backend", "encore.gen")), false);

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
  assert.deepEqual(Object.keys(manifest.scripts).sort(), ["build", "check", "deploy", "dev", "setup", "status"]);
  assert.equal(manifest.scripts.setup, "node scripts/nstack-local.mjs setup");
  assert.equal(manifest.scripts.dev, "node scripts/dev.mjs");
  assert.equal(manifest.scripts.build, "node scripts/nstack-client.mjs gen && pnpm --dir frontend build");
  assert.equal(manifest.scripts.check, "node scripts/check.mjs");
  assert.equal(manifest.scripts.deploy, "nstack deploy");
  assert.equal(manifest.scripts.status, "nstack status");

  const generatedConfig = readFileSync(path.join(target, "nstack.config.mjs"), "utf8");
  assert.match(generatedConfig, /frontendContext: "\."/);
  assert.match(generatedConfig, /path: "\/api\/ready"/);

  const encoreApp = JSON.parse(readFileSync(path.join(target, "backend", "encore.app"), "utf8"));
  assert.equal(encoreApp.id, "");

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
  assert.match(checkRunner, /"scripts\/nstack-client\.mjs", "gen"/);

  const backendManifest = JSON.parse(readFileSync(path.join(target, "backend", "package.json"), "utf8"));
  assert.equal(backendManifest.scripts.test, "node --test");

  const generatedClient = readFileSync(path.join(target, "frontend", "app", "generated", "encore-client.ts"), "utf8");
  assert.match(generatedClient, /Client is an API client for the app Encore application/);
  assert.match(generatedClient, /nstack\/Dokploy target/);
  assert.doesNotMatch(generatedClient, /encr\.app/);
  assert.match(generatedClient, /public async status/);

  const backendDockerfile = readFileSync(path.join(target, "backend", "Dockerfile"), "utf8");
  assert.match(backendDockerfile, /apt-get install -y --no-install-recommends ca-certificates/);
  assert.match(backendDockerfile, /ENCORE_TELEMETRY_DISABLED=1/);
  assert.match(backendDockerfile, /scripts\/nstack-cron-runner\.mjs/);
  assert.match(backendDockerfile, /encore debug meta -f json > \.encore\/nstack\/meta\.json/);
  assert.match(backendDockerfile, /--outdir=\.encore\/nstack\/cron-runner/);
  assert.match(backendDockerfile, /find \.encore\/nstack -name '\*\.map' -delete/);
  assert.match(backendDockerfile, /ENV RUST_LOG=info/);
  assert.match(backendDockerfile, /COPY --from=build \/workspace\/backend\/\.encore\/nstack\/cron-runner/);
  assert.doesNotMatch(backendDockerfile, /source=\\?\.git|target=\/context|git-commit/);
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
    await runCli(["init", target, "--yes", "--skip-install"]);
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

test("init next steps enter the generated project directory", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-init-next-"));
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    const report = await runCli(["init", "web-app", "--yes", "--skip-install"]);
    assert.deepEqual(report.next, [
      "cd web-app",
      "nstack setup",
      "nstack configure --domain <domain> --dokploy-url <url> --dokploy-api-key <key> --repository <git-url>",
      "nstack deploy",
    ]);
  } finally {
    process.chdir(previousCwd);
  }
});

test("configure persists provider-specific source settings non-interactively", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-configure-source-"));
  const target = path.join(cwd, "app");

  await runCli(["init", target, "--yes", "--skip-install"]);
  const output = [];
  const originalLog = console.log;
  const previousCwd = process.cwd();
  process.chdir(target);
  try {
    console.log = (value = "") => output.push(String(value));
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
    console.log = originalLog;
    process.chdir(previousCwd);
  }

  assert.ok(output.includes("Next:"));
  assert.ok(output.includes("  nstack deploy"));

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

  assert.equal(
    execFileSync("git", ["-C", target, "remote", "get-url", "origin"], { encoding: "utf8" }).trim(),
    "git@git.example.test:acme/demo.git",
  );
  assert.equal(execFileSync("git", ["-C", target, "log", "-1", "--pretty=%s"], { encoding: "utf8" }).trim(), "init");
});

test("configure infers provider-backed source settings from Dokploy", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-configure-infer-source-"));
  const target = path.join(cwd, "app");

  await runCli(["init", target, "--yes", "--skip-install"]);
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

  const report = await runCli(["init", target, "--skip-install"]);

  assert.equal(report.files.localEnv, null);
  assert.deepEqual(report.next, [
    `cd ${target}`,
    "nstack setup",
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
    "--skip-install",
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
    "--skip-install",
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
  assert.deepEqual(report.next, [`cd ${target}`, "nstack setup", "nstack deploy"]);
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
      "--skip-install",
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

test("interactive init can select a configured Dokploy instance", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-init-dokploy-instance-"));
  const target = path.join(cwd, "app");
  const instancesFile = path.join(cwd, "dokploy-instances.json");
  saveDokployInstance({ name: "Production", url: "https://dokploy.saved.test", apiKey: "saved-token" }, instancesFile);

  const envKeys = [
    "NSTACK_DOKPLOY_INSTANCES_FILE",
    "NSTACK_INIT_DEPLOY",
    "NSTACK_DOMAIN",
    "NSTACK_DOKPLOY_INSTANCE",
    "NSTACK_GIT_SOURCE",
    "NSTACK_SOURCE_TYPE",
    "NSTACK_REPOSITORY",
    "NSTACK_BRANCH",
    "NSTACK_GIT_SSH_KEY_ID",
    "NSTACK_PACKAGE_MANAGER",
    "DOKPLOY_URL",
    "DOKPLOY_API_KEY",
  ];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalIsTTY = process.stdin.isTTY;
  const originalFetch = globalThis.fetch;
  for (const key of envKeys) delete process.env[key];

  try {
    process.stdin.isTTY = true;
    process.env.NSTACK_DOKPLOY_INSTANCES_FILE = instancesFile;
    process.env.NSTACK_INIT_DEPLOY = "true";
    process.env.NSTACK_DOMAIN = "saved.example.test";
    process.env.NSTACK_DOKPLOY_INSTANCE = "Production";
    process.env.NSTACK_GIT_SOURCE = "manual";
    process.env.NSTACK_SOURCE_TYPE = "git";
    process.env.NSTACK_REPOSITORY = "git@git.example.test:acme/saved.git";
    process.env.NSTACK_BRANCH = "main";
    process.env.NSTACK_GIT_SSH_KEY_ID = "ssh-key-1";
    process.env.NSTACK_PACKAGE_MANAGER = "pnpm";
    globalThis.fetch = async (url) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.hostname, "dokploy.saved.test");
      if (parsed.pathname === "/api/trpc/gitProvider.getAll") return Response.json({ json: [] });
      assert.fail(`Unexpected Dokploy endpoint ${parsed.pathname}`);
    };

    const report = await runCli(["init", target, "--skip-install"]);
    assert.equal(report.deploy.dokployUrl, "https://dokploy.saved.test");
    assert.equal(report.deploy.dokployApiKeySet, true);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdin.isTTY = originalIsTTY;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }

  const localEnv = readFileSync(path.join(target, ".nstack", "local.env"), "utf8");
  assert.match(localEnv, /NSTACK_DOMAIN=saved\.example\.test/);
  assert.match(localEnv, /DOKPLOY_URL=https:\/\/dokploy\.saved\.test/);
  assert.match(localEnv, /DOKPLOY_API_KEY=saved-token/);
  assert.match(localEnv, /NSTACK_SOURCE_TYPE=git/);
  assert.match(localEnv, /NSTACK_REPOSITORY=git@git\.example\.test:acme\/saved\.git/);
  assert.match(localEnv, /NSTACK_GIT_SSH_KEY_ID=ssh-key-1/);
});

test("interactive init builds repository URLs from provider owner and repo prompts", async () => {
  const cases = [
    {
      sourceType: "github",
      providerId: "github-1",
      provider: { providerType: "github", github: { githubId: "github-1", isConfigured: true } },
      configured: { githubId: "github-1" },
      endpoint: "github.githubProviders",
      owner: "acme",
      repo: "github-app",
      expected: "https://github.com/acme/github-app.git",
    },
    {
      sourceType: "gitlab",
      providerId: "gitlab-1",
      provider: { providerType: "gitlab", gitlab: { gitlabId: "gitlab-1", gitlabUrl: "https://gitlab.example.test", isConfigured: true } },
      configured: { gitlabId: "gitlab-1" },
      endpoint: "gitlab.gitlabProviders",
      owner: "platform/apps",
      repo: "gitlab-app",
      expected: "https://gitlab.example.test/platform/apps/gitlab-app.git",
    },
    {
      sourceType: "gitea",
      providerId: "gitea-1",
      provider: { providerType: "gitea", gitea: { giteaId: "gitea-1", giteaUrl: "https://git.example.test", isConfigured: true } },
      configured: { giteaId: "gitea-1" },
      endpoint: "gitea.giteaProviders",
      owner: "angrymouse",
      repo: "forgejo-app",
      expected: "https://git.example.test/angrymouse/forgejo-app.git",
    },
  ];

  const envKeys = [
    "NSTACK_INIT_DEPLOY",
    "NSTACK_DOMAIN",
    "NSTACK_GIT_SOURCE",
    "NSTACK_GIT_OWNER",
    "NSTACK_REPOSITORY_NAME",
    "NSTACK_BRANCH",
    "NSTACK_PACKAGE_MANAGER",
    "DOKPLOY_URL",
    "DOKPLOY_API_KEY",
  ];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalIsTTY = process.stdin.isTTY;
  const originalFetch = globalThis.fetch;

  try {
    process.stdin.isTTY = true;
    process.env.NSTACK_INIT_DEPLOY = "true";
    process.env.NSTACK_PACKAGE_MANAGER = "pnpm";
    process.env.DOKPLOY_URL = "https://dokploy.example.test";
    process.env.DOKPLOY_API_KEY = "secret-token";
    process.env.NSTACK_BRANCH = "main";

    for (const item of cases) {
      const cwd = mkdtempSync(path.join(tmpdir(), `nstack-init-${item.sourceType}-`));
      const target = path.join(cwd, "app");
      process.env.NSTACK_DOMAIN = `${item.sourceType}.example.test`;
      process.env.NSTACK_GIT_SOURCE = `${item.sourceType}:${item.providerId}`;
      process.env.NSTACK_GIT_OWNER = item.owner;
      process.env.NSTACK_REPOSITORY_NAME = item.repo;
      globalThis.fetch = async (url) => {
        const parsed = new URL(String(url));
        const endpoint = parsed.pathname.replace("/api/trpc/", "");
        if (endpoint === "gitProvider.getAll") return Response.json({ json: [item.provider] });
        if (endpoint === item.endpoint) return Response.json({ json: [item.configured] });
        assert.fail(`Unexpected Dokploy endpoint ${endpoint}`);
      };

      const report = await runCli(["init", target, "--skip-install"]);
      assert.equal(report.deploy.source.type, item.sourceType);
      assert.equal(report.deploy.source.repository, item.expected);
      assert.equal(
        execFileSync("git", ["-C", target, "remote", "get-url", "origin"], { encoding: "utf8" }).trim(),
        item.expected,
      );

      const localEnv = readFileSync(path.join(target, ".nstack", "local.env"), "utf8");
      assert.match(localEnv, new RegExp(`NSTACK_SOURCE_TYPE=${item.sourceType}`));
      assert.match(localEnv, new RegExp(`NSTACK_${item.sourceType.toUpperCase()}_ID=${item.providerId}`));
      assert.match(localEnv, new RegExp(`NSTACK_REPOSITORY=${item.expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.stdin.isTTY = originalIsTTY;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test("configure --json reports link metadata without API key values", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nstack-config-json-"));
  const target = path.join(cwd, "app");
  await runCli(["init", target, "--yes", "--skip-install"]);

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
