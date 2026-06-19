import { formatDotEnv, idOf, parseDotEnv, slugify } from "../util.js";
import { OBJECT_STORAGE_PUBLIC_SERVICE_NAME } from "../object-storage.js";
import { CRON_RUNNER_BUNDLE_PATH } from "../cron-runner.js";

export const DOKPLOY_REDIS_IMAGE = "docker.dragonflydb.io/dragonflydb/dragonfly";
export const DOKPLOY_REDIS_COMMAND = "dragonfly";
export const DOKPLOY_REDIS_ARGS = [
  "--logtostderr",
  "--dir",
  "/data",
  "--dbfilename",
  "dump",
  "--default_lua_flags=allow-undeclared-keys",
];

export class DokployClient {
  constructor({ url, apiKey }) {
    if (!url) throw new Error("Dokploy URL is required.");
    if (!apiKey) throw new Error("Dokploy API key is required.");
    this.url = url.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async trpcGet(endpoint, params = {}) {
    const query = Object.keys(params).length
      ? `?input=${encodeURIComponent(JSON.stringify({ json: params }))}`
      : "";
    return this.request(`/api/trpc/${endpoint}${query}`, { method: "GET" });
  }

  async apiGet(endpoint, params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    return this.request(`/api/${endpoint}${query.size ? `?${query}` : ""}`, { method: "GET" });
  }

  async apiPost(endpoint, data = {}) {
    return this.request(`/api/${endpoint}`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async request(path, init) {
    const response = await fetch(`${this.url}${path}`, {
      ...init,
      headers: {
        "x-api-key": this.apiKey,
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // keep text body
    }
    if (!response.ok) {
      throw new Error(`Dokploy ${init.method} ${path} failed: ${response.status} ${typeof body === "string" ? body : JSON.stringify(body)}`);
    }
    return unwrap(body);
  }
}

function unwrap(body) {
  return body?.result?.data?.json ?? body?.result?.data ?? body?.json ?? body;
}

export class DokployProvider {
  constructor({ config, state }) {
    this.config = config;
    this.state = state;
    this.client = new DokployClient({
      url: config.deploy.provider.url,
      apiKey: config.deploy.provider.apiKey,
    });
  }

  async checkConnection() {
    return asList(await this.client.apiGet("project.all"));
  }

  async ensureProject() {
    const name = this.config.deploy.provider.projectName;
    if (this.state.dokploy?.projectId) return this.state.dokploy.projectId;
    const existing = await this.findProjectByName(name);
    if (existing) return existing;
    const created = await this.client.apiPost("project.create", { name, description: "Managed by nstack" });
    return idOf(created, ["projectId", "id"]) || await this.findProjectByName(name);
  }

  async ensureEnvironment(projectId) {
    const name = this.config.deploy.provider.environmentName;
    if (this.state.dokploy?.environmentId) return this.state.dokploy.environmentId;
    const existing = await this.findEnvironmentByName(projectId, name);
    if (existing) return existing;
    const created = await this.client.apiPost("environment.create", { name, projectId, description: "Managed by nstack" });
    return idOf(created, ["environmentId", "id"]) || await this.findEnvironmentByName(projectId, name);
  }

  async ensurePostgres(environmentId, infra, options = {}) {
    const name = `${this.config.app.slug}-postgres`;
    if (this.state.dokploy?.postgresId) return this.state.dokploy.postgresId;
    const existing = await this.findPostgresId(environmentId);
    if (existing) {
      if (options.passwordGenerated) throw existingInfraSecretError("Postgres", name, "NSTACK_POSTGRES_PASSWORD");
      return existing;
    }
    const payload = {
      name,
      appName: name,
      databaseName: infra.postgres.database,
      databaseUser: infra.postgres.user,
      databasePassword: infra.postgres.password,
      dockerImage: "postgres:17-alpine",
      environmentId,
      description: "Managed by nstack",
      ...serverPart(this.config),
    };
    const created = await this.client.apiPost("postgres.create", payload);
    const id = idOf(created, ["postgresId", "id"]);
    if (id) await this.client.apiPost("postgres.deploy", { postgresId: id });
    return id;
  }

  async syncPostgresConnection(postgresId, infra) {
    if (!postgresId || !infra.postgres) return;
    const postgres = await this.client.apiGet("postgres.one", { postgresId });
    if (postgres?.appName) {
      infra.postgres.appName = postgres.appName;
      infra.postgres.host = `${postgres.appName}:5432`;
    }
    if (postgres?.databaseName && !infra.postgres.database) infra.postgres.database = postgres.databaseName;
    if (postgres?.databaseUser) infra.postgres.user = postgres.databaseUser;
  }

  async ensureRedis(environmentId, infra, options = {}) {
    const name = `${this.config.app.slug}-redis`;
    if (this.state.dokploy?.redisId) return this.state.dokploy.redisId;
    const existing = await this.findRedisId(environmentId);
    if (existing) {
      if (options.passwordGenerated) throw existingInfraSecretError("Redis", name, "NSTACK_REDIS_PASSWORD");
      return existing;
    }
    const created = await this.client.apiPost("redis.create", {
      name,
      appName: name,
      databasePassword: infra.redis.password,
      dockerImage: DOKPLOY_REDIS_IMAGE,
      environmentId,
      description: "Managed by nstack (Dragonfly Redis-compatible cache)",
      ...serverPart(this.config),
    });
    const id = idOf(created, ["redisId", "id"]);
    if (id) {
      const redis = await this.client.apiGet("redis.one", { redisId: id }).catch(() => null);
      const appName = redis?.appName || name;
      await this.client.apiPost("redis.update", {
        redisId: id,
        name,
        appName,
        databasePassword: infra.redis.password,
        dockerImage: DOKPLOY_REDIS_IMAGE,
        command: DOKPLOY_REDIS_COMMAND,
        args: [...DOKPLOY_REDIS_ARGS, "--requirepass", infra.redis.password],
        env: formatDotEnv({ REDIS_PASSWORD: infra.redis.password }),
      });
      await this.client.apiPost("redis.deploy", { redisId: id });
    }
    return id;
  }

  async syncRedisConnection(redisId, infra) {
    if (!redisId || !infra.redis) return;
    const redis = await this.client.apiGet("redis.one", { redisId });
    if (redis?.appName) {
      infra.redis.appName = redis.appName;
      infra.redis.host = `${redis.appName}:6379`;
    }
  }

  async upsertCompose(environmentId, composeFile, env = "", options = {}) {
    const name = `${this.config.app.slug}-app`;
    const stateId = this.state.dokploy?.composeId;
    const source = options.source || null;
    if (stateId) {
      await this.updateComposeFile(environmentId, stateId, composeFile, source);
      await this.saveComposeEnvironment(stateId, env);
      await this.ensureSourceWebhook(stateId, source);
      return stateId;
    }
    const existing = await this.findByName("compose.search", { environmentId, name, limit: 50 }, name, ["composeId", "id"]);
    if (existing) {
      await this.updateComposeFile(environmentId, existing, composeFile, source);
      await this.saveComposeEnvironment(existing, env);
      await this.ensureSourceWebhook(existing, source);
      return existing;
    }
    const created = await this.client.apiPost("compose.create", {
      name,
      appName: this.config.app.slug,
      environmentId,
      composeType: "docker-compose",
      composeFile,
      sourceType: "raw",
      ...serverPart(this.config),
    });
    const composeId = idOf(created, ["composeId", "id"]);
    if (!composeId) throw new Error(`Dokploy compose.create did not return a compose id: ${JSON.stringify(created)}`);
    await this.updateComposeFile(environmentId, composeId, composeFile, source);
    await this.saveComposeEnvironment(composeId, env);
    await this.ensureSourceWebhook(composeId, source);
    return composeId;
  }

  async updateComposeFile(environmentId, composeId, composeFile, source = null) {
    await this.client.apiPost("compose.update", {
      composeId,
      name: `${this.config.app.slug}-app`,
      appName: this.config.app.slug,
      composeFile,
      composeType: "docker-compose",
      composePath: source?.composePath || "./docker-compose.yml",
      sourceType: source?.sourceType || "raw",
      ...composeSourcePayload(source),
      environmentId,
    });
  }

  async resolveComposeSource() {
    const sourceConfig = this.config.deploy.source || {};
    const providers = await loadDokploySourceProviders(this.client);
    return resolveComposeSourceConfig(sourceConfig, providers, { requireConfiguredProvider: true });
  }

  async saveComposeEnvironment(composeId, env = "") {
    try {
      await this.client.apiPost("compose.saveEnvironment", { composeId, env });
    } catch (error) {
      if (!isUnknownEndpoint(error)) throw error;
      await this.client.apiPost("compose.update", { composeId, env });
    }
  }

  async ensureSourceWebhook(composeId, source = null) {
    if (source?.sourceType !== "gitea") return null;
    const compose = await this.client.apiGet("compose.one", { composeId });
    return ensureGiteaComposeWebhook({
      dokployUrl: this.client.url,
      compose,
      source,
    });
  }

  async ensureDomains(composeId, resources = {}) {
    const domains = asList(await this.client.apiGet("domain.byComposeId", { composeId }));
    const expected = expectedComposeDomains(this.config, composeId, resources);
    const deleted = new Set();
    for (const domain of staleManagedDomains(this.config, domains, expected)) {
      const domainId = idOf(domain, ["domainId", "id"]);
      if (!domainId) continue;
      await this.client.apiPost("domain.delete", { domainId });
      deleted.add(domainId);
    }
    const remaining = domains.filter((domain) => !deleted.has(idOf(domain, ["domainId", "id"])));
    for (const domain of expected) {
      await this.upsertDomain(remaining, domain);
    }
  }

  async validateAppDomain() {
    const domain = this.config.app.domain || "";
    if (!domain) throw new Error("App domain is required before Dokploy DNS validation.");
    const serverIp = await this.domainValidationServerIp();
    const result = await this.client.apiPost("domain.validateDomain", {
      domain,
      ...(serverIp ? { serverIp } : {}),
    });
    const report = summarizeDomainValidation(result, domain, serverIp);
    if (!report.valid) {
      const expected = report.expectedIp || "the Dokploy server";
      const resolved = report.resolvedIp || "(unresolved)";
      throw new Error(`DNS for ${domain} resolves to ${resolved}, expected ${expected}. Point the domain at Dokploy before deploying.`);
    }
    return report;
  }

  async domainValidationServerIp() {
    const serverId = this.config.deploy.provider.serverId || "";
    if (serverId) {
      try {
        const server = await this.client.apiGet("server.one", { serverId });
        const ip = publicIpFromValue(server);
        if (ip) return ip;
      } catch {
        // Fall through to Dokploy's own current server IP helper.
      }
    }
    try {
      const ip = publicIpFromValue(await this.client.apiGet("settings.getIp"));
      if (ip) return ip;
    } catch {
      // Older Dokploy versions may not expose settings.getIp.
    }
    return publicIpFromValue(await this.client.apiGet("server.publicIp"));
  }

  async upsertDomain(existing, payload) {
    const current = existing.find((domain) =>
      domain.host === payload.host &&
      String(domain.path || "/") === payload.path &&
      domain.serviceName === payload.serviceName);
    const data = {
      ...payload,
      https: true,
      certificateType: "letsencrypt",
      domainType: "compose",
    };
    if (current) {
      await this.client.apiPost("domain.update", { ...data, domainId: idOf(current, ["domainId", "id"]) });
      return;
    }
    await this.client.apiPost("domain.create", data);
  }

  async syncSchedules(composeId, crons, { prune = true } = {}) {
    const previous = this.state.dokploy?.schedules || {};
    if (crons.length === 0 && !prune && Object.keys(previous).length === 0) return {};

    const existing = asList(await this.client.apiGet("schedule.list", {
      id: composeId,
      scheduleType: "compose",
    }));
    const byName = new Map(existing.map((schedule) => [schedule.name, schedule]));
    const next = {};
    const desiredNames = new Set();

    for (const { cron, payload } of expectedComposeSchedules(this.config, composeId, crons)) {
      desiredNames.add(payload.name);
      const current = byName.get(payload.name);
      const scheduleId = idOf(current, ["scheduleId", "id"]) || previous[cron.name] || "";
      if (scheduleId) {
        await this.client.apiPost("schedule.update", { ...payload, scheduleId });
        next[cron.name] = scheduleId;
        continue;
      }
      const created = await this.client.apiPost("schedule.create", payload);
      next[cron.name] = idOf(created, ["scheduleId", "id"]) || await this.findScheduleId(composeId, payload.name);
    }

    if (prune) {
      const managedPrefix = scheduleNamePrefix(this.config);
      const deleted = new Set();
      for (const schedule of existing) {
        const scheduleId = idOf(schedule, ["scheduleId", "id"]);
        if (!scheduleId || !schedule.name?.startsWith(managedPrefix) || desiredNames.has(schedule.name)) continue;
        await this.client.apiPost("schedule.delete", { scheduleId });
        deleted.add(scheduleId);
      }
      for (const [cronName, scheduleId] of Object.entries(previous)) {
        if (!scheduleId || next[cronName] || deleted.has(scheduleId)) continue;
        await this.client.apiPost("schedule.delete", { scheduleId });
      }
    }

    return next;
  }

  async findScheduleId(composeId, name) {
    const schedules = asList(await this.client.apiGet("schedule.list", {
      id: composeId,
      scheduleType: "compose",
    }));
    const found = schedules.find((schedule) => schedule.name === name);
    return found ? idOf(found, ["scheduleId", "id"]) : "";
  }

  async deploy(composeId, release, options = {}) {
    await this.client.apiPost("compose.deploy", {
      composeId,
      title: options.title || `nstack ${release.tag}`,
      description: options.description || `Deploy ${release.commit}`,
    });
  }

  async redeploy(composeId, release) {
    await this.client.apiPost("compose.redeploy", {
      composeId,
      title: `nstack retry ${release.tag}`,
      description: `Redeploy ${release.commit}`,
    });
  }

  async cleanUnusedImages() {
    return this.client.apiPost("settings.cleanUnusedImages", {
      ...serverPart(this.config),
    });
  }

  async enableDockerCleanup() {
    return this.client.apiPost("settings.updateDockerCleanup", {
      enableDockerCleanup: true,
      ...serverPart(this.config),
    });
  }

  async pullExistingState(resources = {}) {
    const projectName = this.config.deploy.provider.projectName;
    const environmentName = this.config.deploy.provider.environmentName;
    const projectId = await this.findProjectByName(projectName);
    if (!projectId) throw new Error(`Dokploy project ${projectName} was not found.`);
    const environmentId = await this.findEnvironmentByName(projectId, environmentName);
    if (!environmentId) throw new Error(`Dokploy environment ${environmentName} was not found in project ${projectName}.`);

    const composeName = `${this.config.app.slug}-app`;
    const composeId = await this.findComposeId(environmentId);
    if (!composeId) throw new Error(`Dokploy Compose app ${composeName} was not found in environment ${environmentName}.`);

    const compose = await this.client.apiGet("compose.one", { composeId });
    const env = parseDotEnv(compose?.env || compose?.environment || "");
    const dokploy = {
      projectId,
      environmentId,
      composeId,
      schedules: await this.pullScheduleMap(composeId, resources.crons || []),
    };

    if ((resources.databases || []).length > 0) {
      dokploy.postgresId = await this.findPostgresId(environmentId);
    }
    if ((resources.caches || []).length > 0) {
      dokploy.redisId = await this.findRedisId(environmentId);
    }

    return {
      dokploy: Object.fromEntries(Object.entries(dokploy).filter(([, value]) => value !== "")),
      env,
      compose: summarizeCompose(compose, composeId),
    };
  }

  async readComposeEnvironment(composeId) {
    const compose = await this.client.apiGet("compose.one", { composeId });
    return parseDotEnv(compose?.env || compose?.environment || "");
  }

  async pullScheduleMap(composeId, crons) {
    if (!crons.length) return {};
    const schedules = asList(await this.client.apiGet("schedule.list", {
      id: composeId,
      scheduleType: "compose",
    }));
    const byName = new Map(schedules.map((schedule) => [schedule.name, schedule]));
    return Object.fromEntries(expectedComposeSchedules(this.config, composeId, crons)
      .map(({ cron, payload }) => [cron.name, idOf(byName.get(payload.name), ["scheduleId", "id"])])
      .filter(([, id]) => Boolean(id)));
  }

  async listComposeDeployments(composeId) {
    return asList(await this.client.apiGet("deployment.allByCompose", { composeId }))
      .map(summarizeDeployment)
      .sort(compareDeploymentsDesc);
  }

  async readDeploymentLogs(deploymentId, { tail = 100 } = {}) {
    return normalizeDeploymentLogs(await this.client.apiGet("deployment.readLogs", {
      deploymentId,
      tail,
    }));
  }

  async killDeployment(deploymentId) {
    return await this.client.apiPost("deployment.killProcess", { deploymentId });
  }

  async remoteStatus() {
    const composeId = this.state.dokploy?.composeId || "";
    if (!composeId) {
      return {
        ok: false,
        reason: "No Dokploy compose ID saved. Run `nstack deploy` first.",
        compose: null,
        domains: [],
        schedules: [],
        deployments: [],
        health: null,
      };
    }

    const [compose, domains, schedules, deployments, health] = await Promise.all([
      capture(() => this.client.apiGet("compose.one", { composeId })),
      capture(() => this.client.apiGet("domain.byComposeId", { composeId })),
      capture(() => this.client.apiGet("schedule.list", { id: composeId, scheduleType: "compose" })),
      capture(() => this.listComposeDeployments(composeId)),
      capture(() => this.client.apiGet("settings.health")),
    ]);

    return {
      ok: compose.ok && domains.ok && schedules.ok,
      compose: compose.ok ? summarizeCompose(compose.value, composeId) : errorSummary(compose.error),
      domains: domains.ok ? asList(domains.value).map(summarizeDomain) : [],
      schedules: schedules.ok ? asList(schedules.value).map(summarizeSchedule) : [],
      deployments: deployments.ok ? deployments.value.slice(0, 5) : [],
      health: health.ok ? { ok: true, value: health.value } : { ok: false, error: health.error.message },
      errors: {
        ...(compose.ok ? {} : { compose: compose.error.message }),
        ...(domains.ok ? {} : { domains: domains.error.message }),
        ...(schedules.ok ? {} : { schedules: schedules.error.message }),
        ...(deployments.ok ? {} : { deployments: deployments.error.message }),
        ...(health.ok ? {} : { health: health.error.message }),
      },
    };
  }

  async findProjectByName(name) {
    const found = asList(await this.client.apiGet("project.all"))
      .find((item) => item?.name === name);
    return found ? idOf(found, ["projectId", "id"]) : "";
  }

  async findEnvironmentByName(projectId, name) {
    const found = asList(await this.client.apiGet("environment.byProjectId", { projectId }))
      .find((item) => item?.name === name);
    return found ? idOf(found, ["environmentId", "id"]) : "";
  }

  async findPostgresId(environmentId) {
    const name = `${this.config.app.slug}-postgres`;
    return this.findByName("postgres.search", { environmentId, name, limit: 50 }, name, ["postgresId", "id"]);
  }

  async findRedisId(environmentId) {
    const name = `${this.config.app.slug}-redis`;
    return this.findByName("redis.search", { environmentId, name, limit: 50 }, name, ["redisId", "id"]);
  }

  async findComposeId(environmentId) {
    const name = `${this.config.app.slug}-app`;
    return this.findByName("compose.search", { environmentId, name, limit: 50 }, name, ["composeId", "id"]);
  }

  async findByName(endpoint, params, name, idNames) {
    const found = asList(await this.client.trpcGet(endpoint, params))
      .find((item) => item?.name === name || item?.appName === name);
    return found ? idOf(found, idNames) : "";
  }
}

function serverPart(config) {
  return config.deploy.provider.serverId ? { serverId: config.deploy.provider.serverId } : {};
}

function composeSourcePayload(source = null) {
  if (!source) return {};
  const common = {
    autoDeploy: true,
    triggerType: "push",
    watchPaths: source.watchPaths || [],
  };
  if (source.sourceType === "github") {
    return {
      githubId: source.githubId,
      owner: source.owner,
      repository: source.repository,
      branch: source.branch,
      ...common,
    };
  }
  if (source.sourceType === "gitlab") {
    return {
      gitlabId: source.gitlabId,
      gitlabOwner: source.owner,
      gitlabRepository: source.repository,
      gitlabBranch: source.branch,
      gitlabPathNamespace: source.gitlabPathNamespace || source.pathNamespace,
      ...(source.gitlabProjectId ? { gitlabProjectId: Number(source.gitlabProjectId) } : {}),
      ...common,
    };
  }
  if (source.sourceType === "bitbucket") {
    return {
      bitbucketId: source.bitbucketId,
      bitbucketOwner: source.owner,
      bitbucketRepository: source.repository,
      bitbucketRepositorySlug: source.bitbucketRepositorySlug || source.repository,
      bitbucketBranch: source.branch,
      ...common,
    };
  }
  if (source.sourceType === "gitea") {
    return {
      giteaId: source.giteaId,
      giteaOwner: source.owner,
      giteaRepository: source.repository,
      giteaBranch: source.branch,
      ...common,
    };
  }
  if (source.sourceType === "git") {
    return {
      customGitUrl: source.repositoryUrl,
      customGitBranch: source.branch,
      ...(source.sshKeyId ? { customGitSSHKeyId: source.sshKeyId } : {}),
    };
  }
  return {};
}

function staleManagedDomains(config, domains, expected) {
  const managedPaths = new Set(expectedComposeDomains(config, "", {
    buckets: [{ name: "public-bucket", public: true }],
  }).map((domain) => domain.path));
  return domains.filter((domain) => {
    if (domain.host !== config.app.domain) return false;
    if (!managedPaths.has(String(domain.path || "/"))) return false;
    return !expected.some((wanted) =>
      wanted.host === domain.host &&
      wanted.path === String(domain.path || "/") &&
      wanted.serviceName === domain.serviceName);
  });
}

export async function ensureGiteaComposeWebhook({ dokployUrl, compose, source }) {
  const refreshToken = compose?.refreshToken || "";
  const gitea = compose?.gitea || {};
  const token = gitea.accessToken || "";
  const giteaUrl = gitea.giteaInternalUrl || gitea.giteaUrl || "";
  if (!refreshToken || !token || !giteaUrl || !source?.owner || !source?.repository) return null;

  const hookUrl = `${String(dokployUrl || "").replace(/\/+$/, "")}/api/deploy/compose/${refreshToken}`;
  const repoPath = `${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}`;
  const apiBase = String(giteaUrl).replace(/\/+$/, "");
  const hooks = await giteaRequest(apiBase, token, `/api/v1/repos/${repoPath}/hooks`, { method: "GET" });
  const existing = asList(hooks).find((hook) => giteaHookUrl(hook) === hookUrl);
  if (existing) return { created: false, hookUrl };

  await giteaRequest(apiBase, token, `/api/v1/repos/${repoPath}/hooks`, {
    method: "POST",
    body: {
      type: "gitea",
      config: {
        url: hookUrl,
        content_type: "json",
      },
      events: ["push"],
      active: true,
    },
  });
  return { created: true, hookUrl };
}

async function giteaRequest(apiBase, token, path, { method = "GET", body = null } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      authorization: `token ${token}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let value = text;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    // keep text response
  }
  if (!response.ok) {
    throw new Error(`Gitea ${method} ${path} failed: ${response.status} ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return value;
}

function giteaHookUrl(hook) {
  return hook?.config?.url || hook?.url || "";
}

export function resolveComposeSourceConfig(sourceConfig = {}, providers = [], options = {}) {
  const repository = sourceConfig.repository || "";
  const branch = sourceConfig.branch || "";
  const parsed = parseGitRepository(repository);
  if (!parsed || !branch) return null;

  const sourceType = resolveSourceType(sourceConfig, parsed, providers);
  if (!sourceType || sourceType === "raw") return null;
  if (sourceType === "git") return plainGitSource(sourceConfig, parsed, branch);

  const explicitProviderId = configuredProviderId(sourceConfig, sourceType);
  const match = providers.find((provider) => providerMatchesSource(provider, sourceType, parsed, sourceConfig));
  if (!match && options.requireConfiguredProvider && (sourceConfig.sourceType || explicitProviderId)) {
    throw unavailableSourceProviderError(sourceType, sourceConfig);
  }
  const providerId = match ? explicitProviderId || providerSpecificId(match, sourceType) : explicitProviderId;
  if (!providerId) {
    if (sourceConfig.sourceType || configuredProviderId(sourceConfig, sourceType)) {
      throw unavailableSourceProviderError(sourceType, sourceConfig);
    }
    return null;
  }

  return {
    sourceType,
    [`${sourceType}Id`]: providerId,
    owner: parsed.owner,
    repository: parsed.repository,
    branch,
    pathNamespace: parsed.pathNamespace,
    gitlabProjectId: sourceConfig.gitlabProjectId || "",
    gitlabPathNamespace: sourceConfig.gitlabPathNamespace || parsed.pathNamespace,
    bitbucketRepositorySlug: sourceConfig.bitbucketRepositorySlug || parsed.repository,
    composePath: sourceConfig.composePath || "deploy/nstack/compose.dokploy.yaml",
    watchPaths: sourceConfig.watchPaths || [],
    refLabel: sourceRefLabelForConfig(sourceConfig),
  };
}

function resolveSourceType(sourceConfig, parsed, providers) {
  if (sourceConfig.sourceType) return sourceConfig.sourceType;
  const explicitIdType = providerTypeFromExplicitId(sourceConfig);
  if (explicitIdType) return explicitIdType;
  const match = providers.find((provider) => providerMatchesAnySource(provider, parsed, sourceConfig));
  return match?.providerType || "";
}

function providerTypeFromExplicitId(sourceConfig) {
  for (const type of ["github", "gitlab", "bitbucket", "gitea"]) {
    if (configuredProviderId(sourceConfig, type)) return type;
  }
  if (sourceConfig.sshKeyId) return "git";
  return "";
}

function providerMatchesAnySource(provider, parsed, sourceConfig) {
  return ["github", "gitlab", "bitbucket", "gitea"]
    .some((type) => providerMatchesSource(provider, type, parsed, sourceConfig));
}

function providerMatchesSource(provider, type, parsed, sourceConfig) {
  if (provider?.providerType !== type) return false;
  if (!providerSourceConfigured(provider, type)) return false;
  const configured = configuredProviderId(sourceConfig, type);
  if (configured && providerSpecificId(provider, type) !== configured) return false;
  if (type === "github") return parsed.host === "github.com";
  if (type === "bitbucket") return parsed.host === "bitbucket.org";
  return providerHosts(provider, type).includes(parsed.host);
}

export async function loadDokploySourceProviders(client) {
  const providers = asList(await client.trpcGet("gitProvider.getAll"))
    .filter((provider) => provider?.providerType);
  const configuredIdsByType = await loadConfiguredProviderIds(client, providers);
  return providers.map((provider) => annotateSourceProvider(provider, configuredIdsByType));
}

async function loadConfiguredProviderIds(client, providers) {
  const types = [...new Set(providers.map((provider) => provider.providerType).filter(Boolean))];
  const entries = await Promise.all(types.map(async (type) => {
    const endpoint = configuredProviderEndpoint(type);
    if (!endpoint) return [type, null];
    try {
      const values = asList(await client.trpcGet(endpoint));
      return [type, new Set(values.map((value) => configuredProviderListId(value, type)).filter(Boolean))];
    } catch (error) {
      if (!isUnknownEndpoint(error)) throw error;
      return [type, null];
    }
  }));
  return Object.fromEntries(entries);
}

function annotateSourceProvider(provider, configuredIdsByType) {
  const type = provider.providerType;
  const configuredIds = configuredIdsByType[type];
  if (!(configuredIds instanceof Set)) return provider;
  return {
    ...provider,
    __nstackSourceConfigured: configuredIds.has(providerSpecificId(provider, type)),
  };
}

function configuredProviderEndpoint(type) {
  return {
    github: "github.githubProviders",
    gitlab: "gitlab.gitlabProviders",
    bitbucket: "bitbucket.bitbucketProviders",
    gitea: "gitea.giteaProviders",
  }[type] || "";
}

function configuredProviderListId(value, type) {
  return value?.[`${type}Id`]
    || value?.[type]?.[`${type}Id`]
    || value?.gitProvider?.[type]?.[`${type}Id`]
    || "";
}

function providerSourceConfigured(provider, type) {
  if (Object.hasOwn(provider, "__nstackSourceConfigured")) return provider.__nstackSourceConfigured !== false;
  const details = provider?.[type] || {};
  if (Object.hasOwn(details, "isConfigured")) return details.isConfigured !== false;
  return true;
}

function unavailableSourceProviderError(sourceType, sourceConfig) {
  const providerId = configuredProviderId(sourceConfig, sourceType);
  const suffix = providerId ? ` id ${providerId}` : "";
  return new Error(
    `Dokploy ${sourceType} provider${suffix} is not configured for source-backed Compose. ` +
    "Configure the provider in Dokploy Settings > Git Providers, then rerun `nstack configure` or `nstack deploy`.",
  );
}

function providerHosts(provider, type) {
  const details = provider?.[type] || {};
  if (type === "gitlab") return [details.gitlabUrl, details.gitlabInternalUrl].map(normalizedHost).filter(Boolean);
  if (type === "gitea") return [details.giteaUrl, details.giteaInternalUrl].map(normalizedHost).filter(Boolean);
  return [];
}

function configuredProviderId(sourceConfig, type) {
  return sourceConfig?.[`${type}Id`] || "";
}

function providerSpecificId(provider, type) {
  return provider?.[type]?.[`${type}Id`] || "";
}

function plainGitSource(sourceConfig, parsed, branch) {
  return {
    sourceType: "git",
    owner: parsed.owner,
    repository: parsed.repository,
    repositoryUrl: sourceConfig.repository,
    branch,
    sshKeyId: sourceConfig.sshKeyId || "",
    composePath: sourceConfig.composePath || "deploy/nstack/compose.dokploy.yaml",
    watchPaths: sourceConfig.watchPaths || [],
    refLabel: sourceRefLabelForConfig(sourceConfig),
  };
}

export function sourceRefLabelForConfig(sourceConfig = {}) {
  const repository = sourceConfig.repository || "";
  const branch = sourceConfig.branch || "";
  const parsed = parseGitRepository(repository);
  if (!parsed || !branch) return "";
  return `${parsed.pathNamespace}@${branch}`;
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
    host: normalizedHost(parsedUrl.host),
    owner: parts[0],
    repository: parts[parts.length - 1],
    pathNamespace: parts.join("/"),
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

function normalizedHost(urlOrHost = "") {
  const value = String(urlOrHost || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host.toLowerCase();
  } catch {
    return value.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
  }
}

export function existingInfraSecretError(kind, name, envKey) {
  return new Error([
    `Existing Dokploy ${kind} ${name} was found, but local nstack state is missing ${envKey}.`,
    "Refusing to deploy with a newly generated password for an existing managed resource.",
    "Run `nstack pull` to recover saved Compose environment values, or remove the stale Dokploy resource and deploy again.",
  ].join(" "));
}

export function expectedComposeDomains(config, composeId = "", resources = {}) {
  const domains = [
    {
      composeId,
      serviceName: "frontend",
      host: config.app.domain,
      path: "/",
      port: 3000,
      internalPath: "/",
      stripPath: false,
    },
    {
      composeId,
      serviceName: "backend",
      host: config.app.domain,
      path: "/api",
      port: 8080,
      internalPath: "/",
      stripPath: true,
    },
  ];
  if ((resources.buckets || []).some((bucket) => bucket.public)) {
    domains.push({
      composeId,
      serviceName: OBJECT_STORAGE_PUBLIC_SERVICE_NAME,
      host: config.app.domain,
      path: "/objects",
      port: 9000,
      internalPath: "/",
      stripPath: true,
    });
  }
  return domains;
}

export function expectedComposeSchedules(config, composeId, crons) {
  return crons.map((cron) => ({ cron, payload: schedulePayload(config, composeId, cron) }));
}

function isUnknownEndpoint(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /compose\.saveEnvironment.*(?:404|NOT_FOUND|Cannot\s+(?:POST|GET)|not found)/i.test(message);
}

async function capture(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function summarizeCompose(value, fallbackId) {
  const envValues = parseDotEnv(value?.env || value?.environment || "");
  const compose = {
    id: idOf(value, ["composeId", "id"]) || fallbackId,
    name: value?.name || "",
    appName: value?.appName || "",
    status: value?.composeStatus || value?.applicationStatus || value?.status || "",
    sourceType: value?.sourceType || "",
    composeType: value?.composeType || "",
    images: extractComposeImages(value?.composeFile || ""),
    envKeys: Object.keys(envValues).sort(),
    updatedAt: value?.updatedAt || null,
    createdAt: value?.createdAt || null,
  };
  Object.defineProperty(compose, "envValues", { value: envValues });
  return compose;
}

function summarizeDomain(value) {
  return {
    id: idOf(value, ["domainId", "id"]),
    host: value?.host || "",
    path: value?.path || "/",
    serviceName: value?.serviceName || "",
    port: value?.port || null,
    https: Boolean(value?.https),
    certificateType: value?.certificateType || "",
    stripPath: Boolean(value?.stripPath),
  };
}

function summarizeDomainValidation(value, domain, expectedIp = "") {
  return {
    domain,
    valid: value?.isValid !== false,
    resolvedIp: value?.resolvedIp || value?.ip || value?.address || "",
    expectedIp,
  };
}

function publicIpFromValue(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  for (const key of ["publicIp", "serverIp", "ip", "ipAddress", "address", "host"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return "";
}

function summarizeSchedule(value) {
  return {
    id: idOf(value, ["scheduleId", "id"]),
    name: value?.name || "",
    cronExpression: value?.cronExpression || "",
    command: typeof value?.command === "string" ? value.command : null,
    enabled: value?.enabled !== false,
    serviceName: value?.serviceName || "",
    timezone: value?.timezone || "",
  };
}

function summarizeDeployment(value) {
  return {
    id: idOf(value, ["deploymentId", "id"]),
    status: value?.status || value?.deploymentStatus || value?.applicationStatus || "",
    title: value?.title || value?.name || "",
    description: value?.description || "",
    createdAt: value?.createdAt || value?.created_at || null,
    startedAt: value?.startedAt || value?.started_at || null,
    finishedAt: value?.finishedAt || value?.finished_at || null,
  };
}

function compareDeploymentsDesc(a, b) {
  const left = Date.parse(a.createdAt || a.startedAt || a.finishedAt || "");
  const right = Date.parse(b.createdAt || b.startedAt || b.finishedAt || "");
  if (Number.isNaN(left) && Number.isNaN(right)) return 0;
  if (Number.isNaN(left)) return 1;
  if (Number.isNaN(right)) return -1;
  return right - left;
}

function normalizeDeploymentLogs(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n");
  }
  if (!value || typeof value !== "object") return "";
  for (const key of ["logs", "log", "output", "data", "content"]) {
    if (typeof value[key] === "string") return value[key];
    if (Array.isArray(value[key])) return normalizeDeploymentLogs(value[key]);
  }
  return JSON.stringify(value, null, 2);
}

function errorSummary(error) {
  return {
    ok: false,
    error: error.message,
  };
}

function extractComposeImages(composeFile) {
  return [...String(composeFile || "").matchAll(/^\s*image:\s*["']?([^"'\n]+)["']?\s*$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function schedulePayload(config, composeId, cron) {
  return {
    name: scheduleName(config, cron),
    description: `Managed by nstack from private Encore cron ${cron.name}`,
    cronExpression: cronExpressionForEncoreCron(cron),
    appName: config.app.slug,
    serviceName: "backend",
    shellType: "sh",
    scheduleType: "compose",
    command: `NODE_ENV=production node ${CRON_RUNNER_BUNDLE_PATH} ${shellQuote(cron.name)}`,
    script: null,
    composeId,
    enabled: true,
    timezone: "UTC",
  };
}

function scheduleName(config, cron) {
  return `${scheduleNamePrefix(config)}${slugify(cron.name)}`;
}

function scheduleNamePrefix(config) {
  return `nstack-${config.app.slug}-`;
}

function cronExpressionForEncoreCron(cron) {
  const normalized = cron.normalizedSchedule || {};
  if (normalized.kind === "every") return everyToCron(normalized.minutes || normalized.value);
  if (normalized.kind === "schedule") return validateCronExpression(normalized.value || cron.schedule);

  const schedule = String(cron.schedule || "").trim();
  if (schedule.startsWith("every:")) return everyToCron(schedule.slice("every:".length));
  if (schedule.startsWith("schedule:")) return validateCronExpression(schedule.slice("schedule:".length));
  return validateCronExpression(schedule);
}

function validateCronExpression(value) {
  const expression = String(value || "").trim();
  if (expression.split(/\s+/).length === 5) return expression;
  throw new Error(`Encore cron schedule "${expression || "(empty)"}" cannot be represented as a Dokploy cron expression.`);
}

function everyToCron(value) {
  const minutes = parseEveryMinutes(value);
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new Error(`Encore cron interval "${value}" must be at least one whole minute for Dokploy schedules.`);
  }
  if (minutes === 1) return "* * * * *";
  if (minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  if (minutes < 1440 && minutes % 60 === 0 && 24 % (minutes / 60) === 0) return `0 */${minutes / 60} * * *`;
  if (minutes === 1440) return "0 0 * * *";
  if (minutes === 10080) return "0 0 * * 0";
  throw new Error(`Encore cron interval "${value}" cannot be represented as a single Dokploy cron expression.`);
}

function parseEveryMinutes(value) {
  if (typeof value === "number") return value;
  const text = String(value || "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)$/i);
  if (!match) return NaN;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("s")) return amount / 60;
  if (unit.startsWith("m")) return amount;
  if (unit.startsWith("h")) return amount * 60;
  return amount * 1440;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["data", "items", "projects", "environments", "domains", "result"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return Object.values(value).find(Array.isArray) || [];
}
