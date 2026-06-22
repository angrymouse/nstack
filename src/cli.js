import path from "node:path";
import { symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { backup } from "./backup.js";
import { runClientGenerator } from "./client.js";
import { cleanup } from "./cleanup.js";
import { configure, deploy, redeploy, rollback, verify, waitForDeployment } from "./deploy.js";
import { cancelDeployment, inspectDeployment, listDeployments, logs } from "./deployments.js";
import { runDev, runDevExec } from "./dev.js";
import { promptDokployInstance } from "./dokploy-instances.js";
import { Prompter } from "./prompt.js";
import { DokployClient, loadDokploySourceProviders } from "./providers/dokploy.js";
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
import { installPackageManagerDependencies, promptPackageManager } from "./package-manager.js";
import { pull } from "./pull.js";
import { createProgress } from "./progress.js";
import { runSecretCommand } from "./secrets.js";
import { runSetup } from "./setup.js";
import { showStatus } from "./status.js";
import { runTargetCommand } from "./targets.js";
import { undeploy } from "./undeploy.js";
import { commandOutput, copyTree, ensureDir, fileExists, mergeEnvFile, readJSON, removeIfExists, run, slugify } from "./util.js";

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
  "skipInstall",
  "prebuilt",
  "noWait",
  "all",
  "dryRun",
  "json",
  "check",
  "print",
  "noBrowser",
  "noDeploy",
  "noInstall",
  "dashboard",
  "stage",
  "follow",
  "watch",
  "metadataOnly",
  "skipDocker",
  "skipTools",
  "noTools",
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
  "from",
  "packageManager",
  "output",
  "backupDestinationId",
  "backupTimeoutMs",
  "backupIntervalMs",
  "code",
  "file",
  "baseUrl",
  "frontendUrl",
  "backendUrl",
  "apiUrl",
  "waitUrl",
]);

export async function runCli(argv) {
  const { command, rest } = splitCommand(argv);
  const { args, options } = parseArgs(rest);
  if (command === "version" || command === "-v" || command === "--version" || options.version) return version(options);
  if (command === "help" || command === "-h" || command === "--help" || options.help) return help();
  if (command === "init") return init(args[0] || ".", options);
  if (command === "configure" || command === "config" || command === "link") return configure(options);
  if (command === "unlink") return unlink(options);
  if (command === "targets" || command === "target" || command === "envs" || command === "environments") return runTargetCommand(args, options);
  if (command === "pull") return pull(options);
  if (command === "backup") return backup(options);
  if (command === "inspect") return inspectDeployment(args, options);
  if ((command === "deployment" || command === "deployments") && args[0] === "inspect") return inspectDeployment(args.slice(1), options);
  if (command === "deployments" || command === "deployment" || command === "releases" || command === "list") return listDeployments(options);
  if (command === "logs" || command === "log") return logs(args, options);
  if (command === "cancel" || command === "cancel-deployment") return cancelDeployment(args, options);
  if (command === "cleanup" || command === "clean") return cleanup(options);
  if (command === "undeploy" || command === "destroy") return undeploy(options);
  if (command === "open") return openTarget(args, options);
  if (command === "setup" || command === "install") return setup(args, options);
  if (command === "dev") return dev(args, options);
  if (command === "devexec" || command === "dev-exec") return devexec(args, options);
  if (command === "client") return client(args, options);
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

async function client(args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const report = runClientGenerator(cwd, args[0] || "gen", {
    capture: Boolean(options.json),
    force: Boolean(options.force),
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  return report;
}

async function dev(args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const report = runDev(cwd, args, { capture: Boolean(options.json) });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  return report;
}

async function setup(args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const report = runSetup(cwd, args, { ...options, capture: Boolean(options.json) });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  return report;
}

async function devexec(args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const report = runDevExec(cwd, args, {
    capture: false,
    code: options.code,
    file: options.file,
    baseUrl: options.baseUrl,
    frontendUrl: options.frontendUrl,
    backendUrl: options.backendUrl,
    apiUrl: options.apiUrl,
    waitUrl: options.waitUrl,
    timeoutMs: options.timeoutMs,
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  return report;
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
  const packageManager = await initPackageManager(options);
  const flagEnv = localDeployValues(options);
  const wizardEnv = await initDeployWizard(cwd, options, flagEnv, { defaultRepoName: slug });
  const localEnv = { ...flagEnv, ...wizardEnv };
  const progress = createProgress({ enabled: !options.json });
  await progress.step("Writing project files", () => {
    copyTree(templateDir, cwd, {
      APP_NAME: appName,
      APP_SLUG: slug,
    });
    ensureClaudeSymlink(cwd);
    if (Object.keys(localEnv).length > 0) {
      mergeEnvFile(path.join(cwd, localEnvPathForTarget(localEnv.NSTACK_TARGET || "prod")), localEnv);
    }
  });
  const install = await progress.step("Installing dependencies", () => installGeneratedDependencies(cwd, options, packageManager));
  await progress.step("Creating initial git commit", () => ensureInitialGitCommit(cwd, localEnv));
  const report = initReport({
    cwd,
    appName,
    slug,
    template,
    localEnv,
    packageManager,
    install,
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

async function initPackageManager(options = {}) {
  const prompter = new Prompter({ yes: options.yes });
  try {
    return await promptPackageManager(prompter, {
      requested: options.packageManager,
      requireAvailable: !(options.skipInstall || options.noInstall),
    });
  } finally {
    prompter.close();
  }
}

function installGeneratedDependencies(cwd, options = {}, packageManager) {
  if (options.skipInstall || options.noInstall) return { skipped: true };
  const commands = installPackageManagerDependencies(packageManager, { cwd });
  return {
    skipped: false,
    packageManager: packageManager.name,
    commands,
  };
}

function ensureInitialGitCommit(cwd, localEnv = {}) {
  const existingRoot = gitWorktreeRoot(cwd);
  if (existingRoot) {
    if (path.resolve(existingRoot) === path.resolve(cwd) && fileExists(path.join(cwd, ".git"))) return;
    commitInitialAppInExistingWorktree(cwd, existingRoot, localEnv);
    return;
  }

  const branch = localEnv.NSTACK_BRANCH || "main";
  run("git", ["init"], { cwd, capture: true });
  run("git", ["checkout", "-B", branch], { cwd, capture: true });
  if (localEnv.NSTACK_REPOSITORY) {
    run("git", ["remote", "add", "origin", localEnv.NSTACK_REPOSITORY], { cwd, capture: true });
  }
  run("git", ["add", "."], { cwd, capture: true });
  const staged = commandOutput("git", ["diff", "--cached", "--name-only"], { cwd }).trim();
  if (!staged) return;
  run("git", ["commit", "-m", "init"], {
    cwd,
    capture: true,
    env: gitCommitEnv(),
  });
}

function commitInitialAppInExistingWorktree(cwd, gitRoot, localEnv = {}) {
  const appPath = normalizeGitPath(path.relative(gitRoot, cwd)) || ".";
  if (localEnv.NSTACK_REPOSITORY) ensureGitOriginInWorktree(gitRoot, localEnv.NSTACK_REPOSITORY);
  run("git", ["add", "--", appPath], { cwd: gitRoot, capture: true });
  const staged = commandOutput("git", ["diff", "--cached", "--name-only", "--", appPath], { cwd: gitRoot }).trim();
  if (!staged) return;
  run("git", ["commit", "-m", "init"], {
    cwd: gitRoot,
    capture: true,
    env: gitCommitEnv(),
  });
}

function ensureGitOriginInWorktree(gitRoot, repository) {
  const origin = safeGitOutput(["remote", "get-url", "origin"], gitRoot);
  if (!origin) run("git", ["remote", "add", "origin", repository], { cwd: gitRoot, capture: true });
}

function gitWorktreeRoot(cwd) {
  return safeGitOutput(["rev-parse", "--show-toplevel"], cwd);
}

function safeGitOutput(args, cwd) {
  try {
    return commandOutput("git", args, { cwd }).trim();
  } catch {
    return "";
  }
}

function normalizeGitPath(file) {
  return String(file || "").replaceAll(path.sep, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function ensureClaudeSymlink(cwd) {
  const target = path.join(cwd, "CLAUDE.md");
  if (fileExists(target)) return;
  symlinkSync("AGENTS.md", target);
}

function gitCommitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "nstack",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "nstack@example.invalid",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "nstack",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "nstack@example.invalid",
  };
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

async function initDeployWizard(cwd, options, existingEnv, { defaultRepoName = "" } = {}) {
  if (!shouldRunInitDeployWizard(options, existingEnv)) return {};
  const prompter = new Prompter({ yes: options.yes });
  try {
    const enabled = await prompter.confirm("NSTACK_INIT_DEPLOY", "Set up Dokploy deployment now?", { defaultValue: true });
    if (!enabled) return {};

    const domain = await prompter.ask("NSTACK_DOMAIN", "App domain");
    const dokploy = await promptDokployInstance(prompter);
    const providers = await loadDokployGitProviders({ dokployUrl: dokploy.url, dokployApiKey: dokploy.apiKey });
    const source = await promptGitSource({ cwd, prompter, providers, defaultRepoName });
    return {
      NSTACK_DOMAIN: domain,
      DOKPLOY_URL: dokploy.url,
      DOKPLOY_API_KEY: dokploy.apiKey,
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
    return loadDokploySourceProviders(client);
  } catch (error) {
    console.log(`Could not read Dokploy git providers; using manual Git setup. ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function promptGitSource({ cwd, prompter, providers, defaultRepoName = "" }) {
  const providerChoices = providers.map(gitProviderChoice).filter(Boolean);
  const manualChoice = { label: "Add Git configuration manually", value: "manual" };
  const choice = await prompter.select("NSTACK_GIT_SOURCE", "Git provider", [...providerChoices, manualChoice]);
  if (choice.value === "manual") return promptManualGitSource({ cwd, prompter, defaultRepoName });
  return promptProviderGitSource({ cwd, prompter, choice, defaultRepoName });
}

async function promptProviderGitSource({ cwd, prompter, choice, defaultRepoName = "" }) {
  const explicitRepository = process.env.NSTACK_REPOSITORY || "";
  if (explicitRepository) {
    const branch = await prompter.ask("NSTACK_BRANCH", "Branch", { defaultValue: inferGitBranch(cwd) || "main" });
    return sourceEnvValues({
      sourceType: choice.sourceType,
      providerId: choice.providerId,
      repository: explicitRepository,
      branch,
    });
  }

  const inferred = parseGitRepository(inferGitRepository(cwd));
  const owner = await promptRepositoryOwner({ prompter, choice, inferred });
  const repositoryName = await promptRepositoryName({ prompter, inferred, defaultRepoName });
  const repository = repositoryUrlForSource({
    sourceType: choice.sourceType,
    host: choice.host,
    owner,
    repository: repositoryName,
  });
  const branch = await prompter.ask("NSTACK_BRANCH", "Branch", { defaultValue: inferGitBranch(cwd) || "main" });
  return sourceEnvValues({
    sourceType: choice.sourceType,
    providerId: choice.providerId,
    repository,
    branch,
  });
}

async function promptManualGitSource({ cwd, prompter, defaultRepoName = "" }) {
  const type = await prompter.select("NSTACK_SOURCE_TYPE", "Git hosting type", [
    { label: "GitHub", value: "github" },
    { label: "GitLab", value: "gitlab" },
    { label: "Bitbucket", value: "bitbucket" },
    { label: "Gitea / Forgejo", value: "gitea" },
    { label: "Plain Git / custom host", value: "git" },
  ]);
  const explicitRepository = process.env.NSTACK_REPOSITORY || "";
  if (type.value !== "git" && !explicitRepository) {
    const inferred = parseGitRepository(inferGitRepository(cwd));
    const host = await promptGitHost({ prompter, sourceType: type.value, inferred });
    const owner = await promptRepositoryOwner({ prompter, choice: { sourceType: type.value, host, provider: null }, inferred });
    const repositoryName = await promptRepositoryName({ prompter, inferred, defaultRepoName });
    const repository = repositoryUrlForSource({ sourceType: type.value, host, owner, repository: repositoryName });
    const branch = await prompter.ask("NSTACK_BRANCH", "Branch", { defaultValue: inferGitBranch(cwd) || "main" });
    const providerId = await prompter.askOptional(providerIdEnvKey(type.value), "Dokploy provider id (optional)");
    return sourceEnvValues({
      sourceType: type.value,
      providerId,
      repository,
      branch,
    });
  }
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
    host,
    provider,
  };
}

async function promptRepositoryOwner({ prompter, choice, inferred = null }) {
  const envOwner = process.env.NSTACK_GIT_OWNER || process.env.NSTACK_REPOSITORY_OWNER || "";
  if (envOwner) return normalizeRepositoryOwner(envOwner);

  const choices = await loadRepositoryOwnerChoices(choice, inferred);
  if (choices.length > 0 && !prompter.yes) {
    const custom = { label: "Custom", value: "__custom_owner__" };
    const selected = await prompter.select("NSTACK_GIT_OWNER", "Git user/org", [...choices, custom]);
    if (selected.value !== custom.value) return selected.value;
  }

  const defaultValue = choices[0]?.value || inferred?.owner || "";
  const owner = await prompter.ask("NSTACK_GIT_OWNER", "Git user/org", { defaultValue });
  return normalizeRepositoryOwner(owner);
}

async function promptRepositoryName({ prompter, inferred = null, defaultRepoName = "" }) {
  const envName = process.env.NSTACK_REPOSITORY_NAME || process.env.NSTACK_GIT_REPOSITORY || "";
  if (envName) return normalizeRepositoryName(envName);
  const repository = await prompter.ask("NSTACK_REPOSITORY_NAME", "Repository name", {
    defaultValue: inferred?.repository || normalizeRepositoryName(defaultRepoName),
  });
  return normalizeRepositoryName(repository);
}

async function promptGitHost({ prompter, sourceType, inferred = null }) {
  const envHost = process.env.NSTACK_GIT_HOST || "";
  if (envHost) return cleanHost(envHost).toLowerCase();
  const defaultHost = inferred?.host || defaultGitHost(sourceType);
  if (sourceType === "github" || sourceType === "bitbucket") return defaultHost;
  const host = await prompter.ask("NSTACK_GIT_HOST", "Git host", { defaultValue: defaultHost });
  return cleanHost(host).toLowerCase();
}

export async function loadRepositoryOwnerChoices(choice, inferred = null, options = {}) {
  const dokployOwners = await dokployRepositoryOwners(choice);
  const creatableOwners = await creatableRepositoryOwners(choice, { token: options.token });
  const publicOwners = options.includePublicFallback === false ? [] : await publicRepositoryOwners(choice);
  const providerOwners = providerOwnerCandidates(choice.provider, choice.sourceType);
  const inferredOwner = inferred && inferred.host === choice.host ? inferred.owner : "";
  const owners = [
    ...currentRepositoryOwnerCandidates(choice, { dokployOwners, publicOwners }),
    inferredOwner,
    ...dokployOwners,
    ...creatableOwners,
    ...publicOwners,
    ...providerOwners,
  ].map(normalizeRepositoryOwner).filter(Boolean);
  return [...new Set(owners)].map((owner) => ({ label: owner, value: owner }));
}

function currentRepositoryOwnerCandidates(choice, { dokployOwners = [], publicOwners = [] } = {}) {
  return [
    ...providerCurrentUserCandidates(choice.provider, choice.sourceType),
    dokployOwners[0] || "",
    publicOwners[0] || "",
  ].filter(Boolean);
}

function providerCurrentUserCandidates(provider, sourceType) {
  const details = provider?.[sourceType] || {};
  const configured = provider?.__nstackConfiguredProvider || {};
  const configuredDetails = configured?.[sourceType] || {};
  const keys = {
    github: ["githubUsername", "username", "login"],
    gitlab: ["gitlabUsername", "username", "login"],
    bitbucket: ["bitbucketUsername", "username"],
    gitea: ["giteaUsername", "username", "login"],
  }[sourceType] || [];
  return [details, configuredDetails, configured]
    .flatMap((value) => keys.map((key) => value?.[key]))
    .filter((value) => typeof value === "string" && value.trim());
}

function providerOwnerCandidates(provider, sourceType) {
  const details = provider?.[sourceType] || {};
  const configured = provider?.__nstackConfiguredProvider || {};
  const configuredDetails = configured?.[sourceType] || {};
  const keys = {
    github: ["owner", "organization", "org", "login", "username", "githubOwner", "githubOrganization", "githubUsername"],
    gitlab: ["owner", "namespace", "groupName", "group", "username", "gitlabOwner", "gitlabNamespace", "gitlabUsername"],
    bitbucket: ["owner", "workspace", "workspaceName", "username", "bitbucketOwner", "bitbucketWorkspace", "bitbucketWorkspaceName", "bitbucketUsername"],
    gitea: ["owner", "organization", "org", "username", "giteaOwner", "giteaOrganization", "giteaUsername"],
  }[sourceType] || [];
  return [details, configured, configuredDetails]
    .flatMap((value) => keys.map((key) => value?.[key]))
    .filter((value) => typeof value === "string" && value.trim());
}

async function dokployRepositoryOwners(choice) {
  const client = choice.provider?.__nstackDokployClient;
  const endpoint = dokployRepositoryEndpoint(choice.sourceType);
  const providerId = choice.providerId || providerSpecificId(choice.provider, choice.sourceType);
  if (!client || !endpoint || !providerId) return [];
  try {
    const repositories = asList(await client.trpcGet(endpoint, { [`${choice.sourceType}Id`]: providerId }));
    return repositories.map(repositoryOwnerFromRepository).filter(Boolean);
  } catch {
    return [];
  }
}

function dokployRepositoryEndpoint(sourceType) {
  return {
    github: "github.getGithubRepositories",
    gitlab: "gitlab.getGitlabRepositories",
    bitbucket: "bitbucket.getBitbucketRepositories",
    gitea: "gitea.getGiteaRepositories",
  }[sourceType] || "";
}

function repositoryOwnerFromRepository(repo) {
  return repo?.owner?.login
    || repo?.owner?.username
    || repo?.owner?.name
    || repo?.namespace?.full_path
    || repo?.namespace?.path
    || ownerFromFullRepositoryName(repo?.full_name)
    || ownerFromFullRepositoryName(repo?.path_with_namespace)
    || ownerFromFullRepositoryName(repo?.url)
    || "";
}

function ownerFromFullRepositoryName(value = "") {
  const text = String(value || "").replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/i, "");
  const parts = text.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

async function creatableRepositoryOwners(choice, options = {}) {
  const token = providerAccessToken(choice.provider, choice.sourceType, options.token);
  if (!token) return [];
  try {
    if (choice.sourceType === "github") return await githubCreatableOwners(token);
    if (choice.sourceType === "gitlab") return await gitlabCreatableOwners(choice.host, token);
    if (choice.sourceType === "bitbucket") return await bitbucketCreatableOwners(token);
    if (choice.sourceType === "gitea") return await giteaCreatableOwners(choice.host, token);
  } catch {
    return [];
  }
  return [];
}

function providerAccessToken(provider, sourceType, explicitToken = "") {
  if (explicitToken) return explicitToken;
  const details = provider?.[sourceType] || {};
  const configured = provider?.__nstackConfiguredProvider || {};
  const configuredDetails = configured?.[sourceType] || {};
  const keys = ["accessToken", "token", "oauthToken", "personalAccessToken", "apiToken", "pat"];
  for (const source of [details, configured, configuredDetails]) {
    for (const key of keys) {
      const value = source?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

async function githubCreatableOwners(token) {
  const query = `query {
    viewer {
      login
      organizations(first: 100) {
        nodes {
          login
          viewerCanCreateRepositories
        }
      }
    }
  }`;
  const data = await fetchJson("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const viewer = data?.data?.viewer || {};
  return [
    viewer.login,
    ...asList(viewer.organizations?.nodes)
      .filter((org) => org.viewerCanCreateRepositories)
      .map((org) => org.login),
  ].filter(Boolean);
}

async function gitlabCreatableOwners(host, token) {
  const base = gitApiBase(host);
  const headers = { authorization: `Bearer ${token}`, "PRIVATE-TOKEN": token };
  const [user, namespaces] = await Promise.all([
    fetchJson(`${base}/api/v4/user`, { headers }),
    fetchJson(`${base}/api/v4/namespaces?per_page=100&owned_only=true`, { headers }),
  ]);
  return [
    user?.username,
    ...asList(namespaces).map((namespace) => namespace.full_path || namespace.path),
  ].filter(Boolean);
}

async function bitbucketCreatableOwners(token) {
  const headers = { authorization: `Bearer ${token}` };
  const permissions = await fetchJson("https://api.bitbucket.org/2.0/user/permissions/workspaces?pagelen=100", { headers });
  return asList(permissions?.values)
    .filter((item) => ["admin", "owner"].includes(String(item.permission || "").toLowerCase()))
    .map((item) => item.workspace?.slug || item.workspace?.name)
    .filter(Boolean);
}

async function giteaCreatableOwners(host, token) {
  const base = gitApiBase(host);
  const headers = { authorization: `token ${token}` };
  const [user, orgs] = await Promise.all([
    fetchJson(`${base}/api/v1/user`, { headers }),
    fetchJson(`${base}/api/v1/user/orgs`, { headers }),
  ]);
  const orgOwners = [];
  for (const org of asList(orgs)) {
    const name = org.username || org.name;
    if (!name) continue;
    const teams = await fetchJson(`${base}/api/v1/orgs/${encodeURIComponent(name)}/teams`, { headers }).catch(() => null);
    if (!Array.isArray(teams) || teams.length === 0 || teams.some(giteaTeamCanCreateRepos)) orgOwners.push(name);
  }
  return [user?.login || user?.username, ...orgOwners].filter(Boolean);
}

async function publicRepositoryOwners(choice) {
  if (choice.sourceType !== "gitea" || !choice.host) return [];
  const base = gitApiBase(choice.host);
  const candidates = localGitUserCandidates();
  const users = [];
  for (const candidate of candidates) {
    const user = await fetchJson(`${base}/api/v1/users/${encodeURIComponent(candidate)}`).catch(() => null);
    const login = user?.login || user?.username;
    if (login) users.push(login);
  }
  const orgs = await fetchJson(`${base}/api/v1/orgs`).catch(() => []);
  const repositories = await fetchJson(`${base}/api/v1/repos/search?limit=100`).catch(() => null);
  return [
    ...users,
    ...asList(repositories?.data).map(repositoryOwnerFromRepository),
    ...asList(orgs).map((org) => org.username || org.name),
  ].filter(Boolean);
}

function localGitUserCandidates() {
  const values = [
    safeCommand("git", ["config", "--get", "user.name"]),
    safeCommand("git", ["config", "--global", "--get", "user.name"]),
    process.env.USER || "",
  ];
  return [...new Set(values.map(gitUserCandidate).filter(Boolean))];
}

function gitUserCandidate(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function safeCommand(command, args) {
  try {
    return commandOutput(command, args).trim();
  } catch {
    return "";
  }
}

function giteaTeamCanCreateRepos(team) {
  if (team?.can_create_org_repo === true) return true;
  const permission = String(team?.permission || "").toLowerCase();
  return ["admin", "owner"].includes(permission);
}

function gitApiBase(host) {
  return `https://${cleanHost(host).replace(/\/+$/, "")}`;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response.json();
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function repositoryUrlForSource({ sourceType, host = "", owner, repository }) {
  const resolvedHost = host || defaultGitHost(sourceType);
  if (!resolvedHost) throw new Error(`${sourceTypeLabel(sourceType)} host is required.`);
  return `https://${resolvedHost}/${normalizeRepositoryOwner(owner)}/${normalizeRepositoryName(repository)}.git`;
}

function defaultGitHost(sourceType) {
  return {
    github: "github.com",
    gitlab: "gitlab.com",
    bitbucket: "bitbucket.org",
  }[sourceType] || "";
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

function normalizeRepositoryOwner(value = "") {
  return String(value || "").trim().replace(/^\/+|\/+$/g, "");
}

function normalizeRepositoryName(value = "") {
  return String(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
}

function inferGitRepository(cwd) {
  try {
    return commandOutput("git", ["config", "--get", "remote.origin.url"], { cwd }).trim();
  } catch {
    return "";
  }
}

function parseGitRepository(repository = "") {
  const value = String(repository || "").trim().replace(/#.*$/, "");
  if (!value) return null;
  const parsedUrl = parseGitUrl(value);
  if (!parsedUrl) return null;
  let pathName = parsedUrl.path.replace(/^\/+|\/+$/g, "");
  if (pathName.endsWith(".git")) pathName = pathName.slice(0, -4);
  const parts = pathName.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return {
    host: cleanHost(parsedUrl.host).toLowerCase(),
    owner: parts.slice(0, -1).join("/"),
    repository: parts[parts.length - 1],
  };
}

function parseGitUrl(value) {
  if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return { host: url.host, path: url.pathname };
    } catch {
      return null;
    }
  }
  const scpLike = value.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
  if (scpLike) return { host: scpLike[1], path: scpLike[2] };
  return null;
}

function inferGitBranch(cwd) {
  try {
    return commandOutput("git", ["branch", "--show-current"], { cwd }).trim();
  } catch {
    return "";
  }
}

function initReport({ cwd, appName, slug, template, localEnv, packageManager = { name: "pnpm" }, install = { skipped: true } }) {
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
    packageManager: packageManager.name,
    install,
    next: initNextSteps({ cwd, localEnv, install, packageManager }),
  };
}

function initNextSteps({ cwd, localEnv, install = { skipped: true }, packageManager = { name: "pnpm" } }) {
  const linked = Boolean(localEnv.NSTACK_DOMAIN && localEnv.DOKPLOY_URL && localEnv.DOKPLOY_API_KEY && localEnv.NSTACK_REPOSITORY);
  const cd = initCdStep(cwd);
  return [
    ...(cd ? [cd] : []),
    ...(install.skipped ? ["nstack setup"] : []),
    ...(linked ? [] : ["nstack configure --domain <domain> --dokploy-url <url> --dokploy-api-key <key> --repository <git-url>"]),
    "nstack deploy",
  ];
}

function initCdStep(cwd) {
  const current = process.cwd();
  const relative = path.relative(current, cwd);
  if (!relative) return "";
  const dir = relative.startsWith("..") || path.isAbsolute(relative) ? cwd : relative;
  return `cd ${shellQuote(dir)}`;
}

function shellQuote(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
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
  nstack init my-app
  cd my-app
  nstack deploy

Configure later:
  nstack configure --domain <host> --dokploy-url <url> --dokploy-api-key <key> --repository <git-url>

Daily commands:
  nstack setup                   install local tooling and project dependencies
  nstack dev                     run Encore, Nuxt, and client sync for local HMR
  nstack devexec '<js>'          run one-shot JS against a temporary dev stack
  nstack deploy                  build, deploy, verify, and print the URL
  nstack status                  show the current release and Dokploy state
  nstack env set <name>          save an app runtime secret locally
  nstack logs [deployment-id]    fetch Dokploy deployment logs
  nstack logs --follow           follow the latest deployment logs

When needed:
  nstack doctor                  explain missing local setup
  nstack target create staging --domain <host>
                                create another Dokploy environment target
  nstack pull                    recover local state from Dokploy
  nstack backup                  snapshot Dokploy config and local data dumps
  nstack rollback [tag|commit]   deploy a previous verified release
  nstack undeploy                delete this app's Dokploy resources
  nstack cleanup                 prune stopped containers, images, volumes, and build cache
  nstack open [dashboard]        open the app or Dokploy dashboard
  nstack client gen              regenerate the Encore client when needed

Options:
  --cwd <dir>                    run against another app directory
  --env <name>                   use a target such as staging
  --json                         print machine-readable output where supported
  --ci                           fail instead of prompting; alias for --yes
  --output <dir>                 write backup output to a custom directory
  --metadata-only                write backup snapshots without data artifacts
  --backup-destination-id <id>   Dokploy backup destination used for local backups

Configure:
  --domain <host>                public domain; DNS is assumed to point at Dokploy
  --build-mode <mode>            compose or registry; compose is default without --registry
  --repository <git-url>         source repo used by Dokploy Compose builds
  --branch <name>                source branch fallback when no commit is available
  --source-type <type>           github, gitlab, bitbucket, gitea, or git
  --dokploy-url <url>            Dokploy panel URL
  --dokploy-api-key <key>        Dokploy API key
  NSTACK_DOKPLOY_INSTANCE        saved Dokploy instance name or URL for prompts
  --package-manager <name>       package manager for init; currently pnpm
  --registry <prefix>            opt into registry image pushes, e.g. ghcr.io/acme/my-app
  --platform <os/arch>           image target platform, linux/amd64 or linux/arm64
  --project <name>               Dokploy project name
  --environment <name>           Dokploy environment name
  --server-id <id>               optional Dokploy deploy server/runner id
  --no-deploy                    skip the interactive init deploy wizard
  --skip-install                 skip init dependency install and pnpm build approvals
  --skip-tools                   check tools without bootstrapping pnpm or Encore
  --skip-docker                  skip local Docker daemon checks in setup/dev/check

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
  NSTACK_BACKUP_DESTINATION_ID   Dokploy backup destination used for local backups
  NSTACK_NO_BACKUPS_ON_DELETION  allow destructive deletion without local backups
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
