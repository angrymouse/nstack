import path from "node:path";
import { fileURLToPath } from "node:url";
import { configure, deploy, redeploy, rollback, verify, waitForDeployment } from "./deploy.js";
import { cancelDeployment, inspectDeployment, listDeployments, logs } from "./deployments.js";
import { Prompter } from "./prompt.js";
import { DokployClient } from "./providers/dokploy.js";
import {
  localEnvPath,
  localEnvPathForTarget,
  normalizeTarget,
  secretsEnvPathForTarget,
  statePath,
  statePathForTarget,
  targetFromOptions,
} from "./config.js";
import { doctor } from "./doctor.js";
import { openTarget } from "./open.js";
import { pull } from "./pull.js";
import { runSecretCommand } from "./secrets.js";
import { showStatus } from "./status.js";
import { listTargets } from "./targets.js";
import { commandOutput, copyTree, ensureDir, fileExists, mergeEnvFile, readJSON, removeIfExists, slugify } from "./util.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const booleanOptions = new Set([
  "help",
  "version",
  "yes",
  "ci",
  "force",
  "skipBuild",
  "skipVerify",
  "skipStatus",
  "skipRemote",
  "prebuilt",
  "noWait",
  "all",
  "dryRun",
  "json",
  "check",
  "print",
  "noBrowser",
  "noDeploy",
  "dashboard",
  "stage",
  "follow",
  "watch",
]);
const valueOptions = new Set([
  "cwd",
  "template",
  "name",
  "slug",
  "domain",
  "buildMode",
  "registry",
  "repository",
  "branch",
  "sourceType",
  "githubId",
  "gitlabId",
  "bitbucketId",
  "giteaId",
  "gitlabProjectId",
  "gitlabPathNamespace",
  "bitbucketRepositorySlug",
  "sshKeyId",
  "composePath",
  "watchPaths",
  "dokployUrl",
  "dokployApiKey",
  "serverId",
  "platform",
  "target",
  "env",
  "project",
  "environment",
  "tail",
  "deploymentId",
  "deployment",
  "statusTimeoutMs",
  "statusIntervalMs",
  "status",
  "limit",
  "timeoutMs",
  "intervalMs",
  "to",
]);

export async function runCli(argv) {
  const { command, rest } = splitCommand(argv);
  const { args, options } = parseArgs(rest);
  if (command === "version" || command === "-v" || command === "--version" || options.version) return version(options);
  if (command === "help" || command === "-h" || command === "--help" || options.help) return help();
  if (command === "init") return init(args[0] || ".", options);
  if (command === "configure" || command === "config" || command === "link") return configure(options);
  if (command === "unlink") return unlink(options);
  if (command === "targets" || command === "target" || command === "envs" || command === "environments") return listTargets(options);
  if (command === "pull") return pull(options);
  if (command === "inspect") return inspectDeployment(args, options);
  if ((command === "deployment" || command === "deployments") && args[0] === "inspect") return inspectDeployment(args.slice(1), options);
  if (command === "deployments" || command === "deployment" || command === "releases" || command === "list") return listDeployments(options);
  if (command === "logs" || command === "log") return logs(args, options);
  if (command === "cancel" || command === "cancel-deployment") return cancelDeployment(args, options);
  if (command === "open") return openTarget(args, options);
  if (command === "env" || command === "secret" || command === "secrets") return runSecretCommand(args, options);
  if (command === "build") return deploy({ ...options, buildOnly: true, skipVerify: true, skipStatus: true });
  if (command === "deploy") return deploy({ ...options, renderOnly: false });
  if (command === "redeploy" || command === "retry") return redeploy(options);
  if (command === "rollback") return rollback(args, options);
  if (command === "wait" || command === "await") return waitForDeployment(options);
  if (command === "render" || command === "plan") return deploy({ ...options, renderOnly: true, skipBuild: true, skipVerify: true });
  if (command === "verify") return verify({ cwd: options.cwd || process.cwd(), target: targetFromOptions(options), json: options.json });
  if (command === "doctor") return doctor(options);
  if (command === "status") return showStatus(options);
  throw new Error(`Unknown command: ${command}. Run nstack help.`);
}

async function init(target, options) {
  const cwd = path.resolve(target);
  const template = options.template || "encore-nuxt";
  const templateDir = path.join(packageRoot, "templates", template);
  if (!fileExists(templateDir)) throw new Error(`Unknown template: ${template}`);
  if (fileExists(cwd) && !options.force && target !== ".") {
    throw new Error(`${cwd} already exists. Pass --force to overwrite generated files.`);
  }
  if (options.force && target !== ".") removeIfExists(cwd);
  ensureDir(cwd);

  const appName = options.name || path.basename(cwd);
  const slug = slugify(options.slug || appName);
  copyTree(templateDir, cwd, {
    APP_NAME: appName,
    APP_SLUG: slug,
  });
  const flagEnv = localDeployValues(options);
  const wizardEnv = await initDeployWizard(cwd, options, flagEnv);
  const localEnv = { ...flagEnv, ...wizardEnv };
  if (Object.keys(localEnv).length > 0) {
    mergeEnvFile(path.join(cwd, localEnvPathForTarget(localEnv.NSTACK_TARGET || "prod")), localEnv);
  }
  const report = initReport({
    cwd,
    appName,
    slug,
    template,
    localEnv,
  });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log(`Initialized ${slug} in ${cwd}`);
  console.log("Next:");
  for (const step of report.next) console.log(`  ${step}`);
  return report;
}

async function unlink(options = {}) {
  const cwd = options.cwd || process.cwd();
  const target = targetFromOptions(options);
  const normalizedTarget = normalizeTarget(target || "prod");
  const removed = [];
  if (target) {
    removed.push(...removePaths(cwd, [localEnvPathForTarget(target), statePathForTarget(target)]));
  } else {
    removed.push(...removePaths(cwd, [localEnvPath, statePath]));
  }
  const report = {
    target: normalizedTarget,
    removed,
    preserved: [secretsEnvPathForTarget(normalizedTarget)],
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log("Unlinked nstack deploy target. App runtime secrets were left intact.");
  return report;
}

function removePaths(cwd, paths) {
  const removed = [];
  for (const file of paths) {
    const absolute = path.join(cwd, file);
    if (fileExists(absolute)) removed.push(file);
    removeIfExists(absolute);
  }
  return removed;
}

function localDeployValues(options) {
  const target = normalizeTarget(targetFromOptions(options) || "prod");
  return {
    ...(options.domain ? { NSTACK_DOMAIN: options.domain } : {}),
    ...(options.buildMode ? { NSTACK_BUILD_MODE: options.buildMode } : {}),
    ...(options.registry ? { NSTACK_REGISTRY: options.registry } : {}),
    ...(options.repository ? { NSTACK_REPOSITORY: options.repository } : {}),
    ...(options.branch ? { NSTACK_BRANCH: options.branch } : {}),
    ...(options.sourceType ? { NSTACK_SOURCE_TYPE: options.sourceType } : {}),
    ...(options.githubId ? { NSTACK_GITHUB_ID: options.githubId } : {}),
    ...(options.gitlabId ? { NSTACK_GITLAB_ID: options.gitlabId } : {}),
    ...(options.bitbucketId ? { NSTACK_BITBUCKET_ID: options.bitbucketId } : {}),
    ...(options.giteaId ? { NSTACK_GITEA_ID: options.giteaId } : {}),
    ...(options.gitlabProjectId ? { NSTACK_GITLAB_PROJECT_ID: options.gitlabProjectId } : {}),
    ...(options.gitlabPathNamespace ? { NSTACK_GITLAB_PATH_NAMESPACE: options.gitlabPathNamespace } : {}),
    ...(options.bitbucketRepositorySlug ? { NSTACK_BITBUCKET_REPOSITORY_SLUG: options.bitbucketRepositorySlug } : {}),
    ...(options.sshKeyId ? { NSTACK_GIT_SSH_KEY_ID: options.sshKeyId } : {}),
    ...(options.composePath ? { NSTACK_COMPOSE_PATH: options.composePath } : {}),
    ...(options.watchPaths ? { NSTACK_WATCH_PATHS: options.watchPaths } : {}),
    ...(options.dokployUrl ? { DOKPLOY_URL: options.dokployUrl } : {}),
    ...(options.dokployApiKey ? { DOKPLOY_API_KEY: options.dokployApiKey } : {}),
    ...(options.serverId ? { DOKPLOY_SERVER_ID: options.serverId } : {}),
    ...(target !== "prod" || options.target || options.env ? { NSTACK_TARGET: target } : {}),
    ...(options.platform ? { NSTACK_PLATFORM: options.platform } : {}),
    ...(options.project ? { DOKPLOY_PROJECT: options.project } : {}),
    ...(options.environment ? { DOKPLOY_ENVIRONMENT: options.environment } : {}),
  };
}

async function initDeployWizard(cwd, options, existingEnv) {
  if (!shouldRunInitDeployWizard(options, existingEnv)) return {};
  const prompter = new Prompter({ yes: options.yes });
  try {
    const enabled = await prompter.confirm("NSTACK_INIT_DEPLOY", "Set up Dokploy deployment now?", { defaultValue: true });
    if (!enabled) return {};

    const domain = await prompter.ask("NSTACK_DOMAIN", "App domain");
    const dokployUrl = await prompter.ask("DOKPLOY_URL", "Dokploy URL");
    const dokployApiKey = await prompter.ask("DOKPLOY_API_KEY", "Dokploy API key", { secret: true });
    const providers = await loadDokployGitProviders({ dokployUrl, dokployApiKey });
    const source = await promptGitSource({ cwd, prompter, providers });
    return {
      NSTACK_DOMAIN: domain,
      DOKPLOY_URL: dokployUrl,
      DOKPLOY_API_KEY: dokployApiKey,
      ...source,
    };
  } finally {
    prompter.close();
  }
}

function shouldRunInitDeployWizard(options, existingEnv) {
  if (options.noDeploy || options.yes || options.ci || options.json) return false;
  if (process.stdin.isTTY !== true) return false;
  return Object.keys(existingEnv).length === 0;
}

async function loadDokployGitProviders({ dokployUrl, dokployApiKey }) {
  try {
    const client = new DokployClient({ url: dokployUrl, apiKey: dokployApiKey });
    return asList(await client.trpcGet("gitProvider.getAll"))
      .filter((provider) => provider?.providerType);
  } catch (error) {
    console.log(`Could not read Dokploy git providers; using manual Git setup. ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function promptGitSource({ cwd, prompter, providers }) {
  const providerChoices = providers.map(gitProviderChoice).filter(Boolean);
  const manualChoice = { label: "Add Git configuration manually", value: "manual" };
  const choice = await prompter.select("NSTACK_GIT_SOURCE", "Git hosting", [...providerChoices, manualChoice]);
  if (choice.value === "manual") return promptManualGitSource({ cwd, prompter });
  return promptProviderGitSource({ cwd, prompter, choice });
}

async function promptProviderGitSource({ cwd, prompter, choice }) {
  const repository = await prompter.ask("NSTACK_REPOSITORY", "Repository URL", { defaultValue: inferGitRepository(cwd) });
  const branch = await prompter.ask("NSTACK_BRANCH", "Branch", { defaultValue: inferGitBranch(cwd) || "main" });
  return sourceEnvValues({
    sourceType: choice.sourceType,
    providerId: choice.providerId,
    repository,
    branch,
  });
}

async function promptManualGitSource({ cwd, prompter }) {
  const type = await prompter.select("NSTACK_SOURCE_TYPE", "Git hosting type", [
    { label: "GitHub", value: "github" },
    { label: "GitLab", value: "gitlab" },
    { label: "Bitbucket", value: "bitbucket" },
    { label: "Gitea / Forgejo", value: "gitea" },
    { label: "Plain Git / custom host", value: "git" },
  ]);
  const repository = await prompter.ask("NSTACK_REPOSITORY", "Repository URL", { defaultValue: inferGitRepository(cwd) });
  const branch = await prompter.ask("NSTACK_BRANCH", "Branch", { defaultValue: inferGitBranch(cwd) || "main" });
  const providerId = type.value === "git"
    ? ""
    : await prompter.askOptional(providerIdEnvKey(type.value), "Dokploy provider id (optional)");
  const sshKeyId = type.value === "git"
    ? await prompter.askOptional("NSTACK_GIT_SSH_KEY_ID", "Dokploy SSH key id for private SSH repos (optional)")
    : "";
  return sourceEnvValues({
    sourceType: type.value,
    providerId,
    repository,
    branch,
    sshKeyId,
  });
}

function gitProviderChoice(provider) {
  const sourceType = provider.providerType;
  const providerId = providerSpecificId(provider, sourceType);
  if (!sourceType || !providerId) return null;
  const host = providerHost(provider, sourceType);
  const name = provider.name || providerDisplayName(provider, sourceType);
  return {
    label: `${sourceTypeLabel(sourceType)}${name ? `: ${name}` : ""}${host ? ` (${host})` : ""}`,
    value: `${sourceType}:${providerId}`,
    sourceType,
    providerId,
  };
}

function sourceEnvValues({ sourceType, providerId = "", repository, branch, sshKeyId = "" }) {
  return {
    NSTACK_SOURCE_TYPE: sourceType,
    NSTACK_REPOSITORY: repository,
    NSTACK_BRANCH: branch,
    ...(providerId ? { [providerIdEnvKey(sourceType)]: providerId } : {}),
    ...(sshKeyId ? { NSTACK_GIT_SSH_KEY_ID: sshKeyId } : {}),
  };
}

function providerIdEnvKey(sourceType) {
  return {
    github: "NSTACK_GITHUB_ID",
    gitlab: "NSTACK_GITLAB_ID",
    bitbucket: "NSTACK_BITBUCKET_ID",
    gitea: "NSTACK_GITEA_ID",
  }[sourceType] || "NSTACK_GIT_PROVIDER_ID";
}

function providerSpecificId(provider, sourceType) {
  return provider?.[sourceType]?.[`${sourceType}Id`] || "";
}

function providerHost(provider, sourceType) {
  const details = provider?.[sourceType] || {};
  if (sourceType === "github") return "github.com";
  if (sourceType === "bitbucket") return "bitbucket.org";
  if (sourceType === "gitlab") return cleanHost(details.gitlabUrl || details.gitlabInternalUrl || "");
  if (sourceType === "gitea") return cleanHost(details.giteaUrl || details.giteaInternalUrl || "");
  return "";
}

function providerDisplayName(provider, sourceType) {
  const details = provider?.[sourceType] || {};
  return details.githubAppName || details.groupName || details.bitbucketWorkspaceName || details.bitbucketUsername || "";
}

function sourceTypeLabel(sourceType) {
  return {
    github: "GitHub",
    gitlab: "GitLab",
    bitbucket: "Bitbucket",
    gitea: "Gitea / Forgejo",
    git: "Plain Git",
  }[sourceType] || sourceType;
}

function cleanHost(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(text.includes("://") ? text : `https://${text}`).host;
  } catch {
    return text.replace(/^https?:\/\//, "").split("/")[0];
  }
}

function inferGitRepository(cwd) {
  try {
    return commandOutput("git", ["config", "--get", "remote.origin.url"], { cwd }).trim();
  } catch {
    return "";
  }
}

function inferGitBranch(cwd) {
  try {
    return commandOutput("git", ["branch", "--show-current"], { cwd }).trim();
  } catch {
    return "";
  }
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function initReport({ cwd, appName, slug, template, localEnv }) {
  const target = normalizeTarget(localEnv.NSTACK_TARGET || "prod");
  const localEnvKeys = Object.keys(localEnv).sort();
  return {
    app: {
      name: appName,
      slug,
      dir: cwd,
    },
    template,
    deploy: {
      target,
      domain: localEnv.NSTACK_DOMAIN || null,
      buildMode: localEnv.NSTACK_BUILD_MODE || (localEnv.NSTACK_REGISTRY ? "registry" : "compose"),
      registry: localEnv.NSTACK_REGISTRY || null,
      source: {
        type: localEnv.NSTACK_SOURCE_TYPE || null,
        repository: localEnv.NSTACK_REPOSITORY || null,
        branch: localEnv.NSTACK_BRANCH || null,
      },
      platform: localEnv.NSTACK_PLATFORM || null,
      project: localEnv.DOKPLOY_PROJECT || null,
      environment: localEnv.DOKPLOY_ENVIRONMENT || null,
      dokployUrl: localEnv.DOKPLOY_URL || null,
      dokployApiKeySet: Boolean(localEnv.DOKPLOY_API_KEY),
      serverId: localEnv.DOKPLOY_SERVER_ID || null,
    },
    files: {
      config: "nstack.config.mjs",
      localEnv: localEnvKeys.length > 0 ? localEnvPathForTarget(target) : null,
    },
    localEnv: {
      keys: localEnvKeys,
    },
    next: initNextSteps(localEnv),
  };
}

function initNextSteps(localEnv) {
  const linked = Boolean(localEnv.NSTACK_DOMAIN && localEnv.DOKPLOY_URL && localEnv.DOKPLOY_API_KEY && localEnv.NSTACK_REPOSITORY);
  return [
    "pnpm install",
    ...(linked ? [] : ["nstack configure --domain <domain> --dokploy-url <url> --dokploy-api-key <key> --repository <git-url>"]),
    "nstack deploy",
  ];
}

function parseArgs(argv) {
  const args = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--") {
      args.push("--", ...argv.slice(i + 1));
      break;
    }
    if (item === "-h") {
      options.help = true;
      continue;
    }
    if (item === "-v") {
      options.version = true;
      continue;
    }
    if (item === "-f") {
      options.follow = true;
      continue;
    }
    if (!item.startsWith("--")) {
      args.push(item);
      continue;
    }
    const option = parseOptionToken(item);
    assertKnownOption(option);
    if (isBooleanOption(option.key)) {
      options[option.key] = option.hasValue ? option.value !== "false" : true;
      continue;
    }
    if (option.hasValue) {
      options[option.key] = option.value;
    } else {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw missingOptionValue(option);
      options[option.key] = argv[i + 1];
      i += 1;
    }
  }
  if (options.env && !options.target) options.target = options.env;
  if (options.ci) options.yes = true;
  if (options.prebuilt) options.skipBuild = true;
  return { args, options };
}

function splitCommand(argv = []) {
  if (argv.length === 0) return { command: "help", rest: [] };
  if (argv[0] === "--help" || argv[0] === "-h") return { command: "help", rest: [] };
  if (!argv[0].startsWith("--")) return { command: argv[0] || "help", rest: argv.slice(1) };

  const prefix = [];
  let i = 0;
  for (; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--") || item === "--") break;
    prefix.push(item);
    const option = parseOptionToken(item);
    assertKnownOption(option);
    if (!option.hasValue && !isBooleanOption(option.key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw missingOptionValue(option);
      prefix.push(argv[i + 1]);
      i += 1;
    }
  }
  return {
    command: argv[i] || "help",
    rest: [...prefix, ...argv.slice(i + 1)],
  };
}

function isBooleanOption(key) {
  return booleanOptions.has(key);
}

function parseOptionToken(item) {
  const raw = item.slice(2);
  const equals = raw.indexOf("=");
  if (equals === -1) {
    return { key: camel(raw), rawKey: raw, value: "", hasValue: false };
  }
  const rawKey = raw.slice(0, equals);
  return {
    key: camel(rawKey),
    rawKey,
    value: raw.slice(equals + 1),
    hasValue: true,
  };
}

function assertKnownOption(option) {
  if (booleanOptions.has(option.key) || valueOptions.has(option.key)) return;
  throw new Error(`Unknown option: --${option.rawKey}. Run nstack help.`);
}

function missingOptionValue(option) {
  return new Error(`Missing value for --${option.rawKey}. Use --${option.rawKey}=<value> if the value starts with --.`);
}

function camel(key) {
  return key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function help() {
  console.log(`nstack

Start:
  nstack init [dir]
  cd <dir>
  pnpm install
  nstack configure --domain <host> --dokploy-url <url> --dokploy-api-key <key> --repository <git-url>
  nstack deploy

Daily commands:
  nstack deploy                  build, deploy, verify, and print the URL
  nstack status                  show the current release and Dokploy state
  nstack env set <name>          save an app runtime secret locally
  nstack logs --follow           follow the latest Dokploy deployment logs

When needed:
  nstack doctor                  explain missing local setup
  nstack pull                    recover local state from Dokploy
  nstack rollback [tag|commit]   deploy a previous verified release
  nstack open [dashboard]        open the app or Dokploy dashboard

Options:
  --cwd <dir>                    run against another app directory
  --env <name>                   use a target such as staging
  --json                         print machine-readable output where supported
  --ci                           fail instead of prompting; alias for --yes

Configure:
  --domain <host>                public domain; DNS is assumed to point at Dokploy
  --build-mode <mode>            compose or registry; compose is default without --registry
  --repository <git-url>         source repo used by Dokploy Compose builds
  --branch <name>                source branch fallback when no commit is available
  --source-type <type>           github, gitlab, bitbucket, gitea, or git
  --dokploy-url <url>            Dokploy panel URL
  --dokploy-api-key <key>        Dokploy API key
  --registry <prefix>            opt into registry image pushes, e.g. ghcr.io/acme/my-app
  --platform <os/arch>           image target platform, linux/amd64 or linux/arm64
  --project <name>               Dokploy project name
  --environment <name>           Dokploy environment name
  --server-id <id>               optional Dokploy deploy server/runner id
  --no-deploy                    skip the interactive init deploy wizard

Deploy:
  --no-wait                      trigger deploy and return before verification/status
  --skip-build                   use already-pushed images
  --skip-verify                  skip public verification; does not promote lastRelease
  --skip-status                  skip post-deploy Dokploy status/drift audit

Other useful flags:
  --follow, -f                   follow logs
  --all                          pull or push all app env keys
  --stage                        save env without redeploying
  --print, --no-browser          print URLs without launching a browser
  --check                        exit nonzero when doctor/status finds a problem
  --version, -v                  print nstack version
  --yes                          fail instead of prompting for missing values
`);
}

function version(options = {}) {
  const pkg = readJSON(path.join(packageRoot, "package.json"), {});
  const report = {
    name: pkg.name || "nstack",
    version: pkg.version || "0.0.0",
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.name} ${report.version}`);
  return report;
}
