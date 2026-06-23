import { objectStorageBucketName } from "../resource-names.js";
import {
  OBJECT_STORAGE_ACCESS_ENV,
  OBJECT_STORAGE_IMAGE,
  OBJECT_STORAGE_INIT_IMAGE,
  OBJECT_STORAGE_INIT_SERVICE_NAME,
  OBJECT_STORAGE_PORT,
  OBJECT_STORAGE_PUBLIC_IMAGE,
  OBJECT_STORAGE_PUBLIC_SERVICE_NAME,
  OBJECT_STORAGE_SECRET_ENV,
  OBJECT_STORAGE_SERVICE_NAME,
  objectStorageServiceHost,
} from "../object-storage.js";
import { stringifyYaml } from "./yaml.js";

export const ENCORE_MIGRATE_IMAGE = "migrate/migrate:v4.15.2";
export const POSTGRES_INIT_IMAGE = "postgres:17-alpine";
export const POSTGRES_INIT_SERVICE = "postgres-init";
export const REDIS_IMAGE = "docker.dragonflydb.io/dragonflydb/dragonfly";

export function renderDokployCompose(ctx) {
  const { config, images = {}, release, build = null } = ctx;
  const resources = normalizeResources(ctx.resources);
  const renderCtx = { ...ctx, resources };
  const backendHost = `${config.app.slug}-backend`;
  const objectStorageHost = objectStorageServiceHost(config);
  const nsqdHost = `${config.app.slug}-nsqd`;
  const nsqlookupdHost = `${config.app.slug}-nsqlookupd`;
  const postgresService = inlinePostgresService(renderCtx);
  const redisService = inlineRedisService(renderCtx);
  const postgresInitService = postgresDatabaseInitService(renderCtx);
  const migrationServices = databaseMigrationServices(renderCtx);
  const doc = {
    name: config.app.slug,
    services: {
      frontend: {
        ...serviceImageOrBuild("frontend", { config, release, image: images.frontend, build }),
        restart: "unless-stopped",
        environment: {
          NODE_ENV: "production",
          HOST: "0.0.0.0",
          PORT: "3000",
          NITRO_HOST: "0.0.0.0",
          NITRO_PORT: "3000",
          NUXT_PUBLIC_API_BASE_URL: "/api",
          NUXT_PUBLIC_NSTACK_API_BASE_URL: "/api",
          NUXT_PUBLIC_NSTACK_TARGET: config.deploy.target,
          NUXT_PUBLIC_NSTACK_DOMAIN: config.app.domain,
          [`NUXT_PUBLIC_NSTACK_${environmentKey(config.deploy.target)}_API_BASE_URL`]: "/api",
          [`NUXT_PUBLIC_NSTACK_${environmentKey(config.deploy.target)}_DOMAIN`]: config.app.domain,
          NUXT_API_SERVER_BASE_URL: `http://${backendHost}:8080`,
          NUXT_API_INTERNAL_BASE_URL: `http://${backendHost}:8080`,
          NSTACK_TARGET: config.deploy.target,
          NSTACK_DOMAIN: config.app.domain,
          NSTACK_API_BASE_URL: `http://${backendHost}:8080`,
          NSTACK_PUBLIC_API_BASE_URL: "/api",
          NSTACK_APP_SLUG: config.app.slug,
          NSTACK_BACKEND_HOST: backendHost,
          NSTACK_GIT_COMMIT: "${NSTACK_GIT_COMMIT:-local}",
          NSTACK_IMAGE_TAG: "${NSTACK_IMAGE_TAG:-local}",
        },
        expose: ["3000"],
        healthcheck: nodeTcpHealthcheck(3000),
        depends_on: {
          backend: { condition: "service_started" },
        },
      },
      backend: {
        ...serviceImageOrBuild("backend", { config, release, image: images.backend, build }),
        restart: "unless-stopped",
        environment: backendEnv(renderCtx),
        expose: ["8080"],
        networks: {
          default: {
            aliases: [backendHost],
          },
        },
        healthcheck: nodeHttpHealthcheck("http://127.0.0.1:8080/__encore/healthz"),
        depends_on: backendDependsOn(renderCtx, migrationServices, postgresInitService, postgresService, redisService),
      },
    },
  };
  Object.assign(doc.services, postgresService);
  Object.assign(doc.services, redisService);
  Object.assign(doc.services, postgresInitService);
  Object.assign(doc.services, migrationServices);
  if (Object.keys(postgresService).length > 0) doc.volumes = { ...(doc.volumes || {}), postgres_data: {} };
  if (Object.keys(redisService).length > 0) doc.volumes = { ...(doc.volumes || {}), redis_data: {} };
  if (!pushProvision(renderCtx, "postgres") && (Object.keys(migrationServices).length > 0 || Object.keys(postgresInitService).length > 0)) {
    doc.networks = { ...(doc.networks || {}), "dokploy-network": { external: true } };
  }

  if (resources.topics.length > 0) {
    doc.services.nsqlookupd = {
      image: "nsqio/nsq:v1.3.0",
      restart: "unless-stopped",
      command: "/nsqlookupd",
      expose: ["4160", "4161"],
      networks: {
        default: {
          aliases: [nsqlookupdHost],
        },
      },
    };
    doc.services.nsqd = {
      image: "nsqio/nsq:v1.3.0",
      restart: "unless-stopped",
      command: `/nsqd --lookupd-tcp-address=${nsqlookupdHost}:4160 --broadcast-address=${nsqdHost} --data-path=/data`,
      volumes: ["nsq_data:/data"],
      expose: ["4150", "4151"],
      networks: {
        default: {
          aliases: [nsqdHost],
        },
      },
      depends_on: {
        nsqlookupd: { condition: "service_started" },
      },
    };
    doc.volumes = { ...(doc.volumes || {}), nsq_data: {} };
  }

  if (resources.buckets.length > 0) {
    doc.services[OBJECT_STORAGE_SERVICE_NAME] = {
      image: OBJECT_STORAGE_IMAGE,
      restart: "unless-stopped",
      command: "/data",
      environment: {
        RUSTFS_ACCESS_KEY: composeEnvValue(OBJECT_STORAGE_ACCESS_ENV, objectStorageFallbackAccessKey(renderCtx)),
        RUSTFS_SECRET_KEY: composeEnvValue(OBJECT_STORAGE_SECRET_ENV, objectStorageFallbackSecretKey(renderCtx)),
        RUSTFS_CONSOLE_ENABLE: "false",
        RUSTFS_SERVER_DOMAINS: `${objectStorageHost}:${OBJECT_STORAGE_PORT}`,
      },
      volumes: ["rustfs_data:/data"],
      expose: [String(OBJECT_STORAGE_PORT)],
      networks: {
        default: {
          aliases: objectStorageAliases(config, resources.buckets, objectStorageHost),
        },
      },
    };
    doc.services[OBJECT_STORAGE_INIT_SERVICE_NAME] = {
      image: OBJECT_STORAGE_INIT_IMAGE,
      restart: "no",
      environment: {
        RUSTFS_ACCESS_KEY: composeEnvValue(OBJECT_STORAGE_ACCESS_ENV, objectStorageFallbackAccessKey(renderCtx)),
        RUSTFS_SECRET_KEY: composeEnvValue(OBJECT_STORAGE_SECRET_ENV, objectStorageFallbackSecretKey(renderCtx)),
      },
      entrypoint: ["/bin/sh"],
      command: ["-c", objectStorageInitScript(config, resources.buckets, objectStorageHost)],
      depends_on: {
        [OBJECT_STORAGE_SERVICE_NAME]: { condition: "service_started" },
      },
    };
    if (resources.buckets.some((bucket) => bucket.public)) {
      doc.services[OBJECT_STORAGE_PUBLIC_SERVICE_NAME] = {
        image: OBJECT_STORAGE_PUBLIC_IMAGE,
        restart: "unless-stopped",
        command: ["/bin/sh", "-c", objectStoragePublicProxyConfig(objectStorageHost)],
        expose: [String(OBJECT_STORAGE_PORT)],
        depends_on: {
          [OBJECT_STORAGE_SERVICE_NAME]: { condition: "service_started" },
        },
      };
    }
    doc.volumes = { ...(doc.volumes || {}), rustfs_data: {} };
  }

  return `# Generated by nstack. Ingress is managed by Dokploy Domains/Traefik.
${stringifyYaml(doc)}`;
}

function environmentKey(target) {
  return String(target || "prod")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase() || "PROD";
}

function serviceImageOrBuild(name, { config, release, image, build }) {
  if (!build) return { image };
  const service = build.services?.[name];
  const localImage = `${config.app.slug}-${name}:\${NSTACK_IMAGE_TAG:-local}`;
  return {
    image: service?.image || localImage,
    pull_policy: "build",
    build: {
      context: build.context,
      dockerfile: service?.dockerfile,
      ...(config.deploy.platform ? { platforms: [config.deploy.platform] } : {}),
      ...(service?.args ? { args: service.args } : {}),
    },
  };
}

function normalizeResources(resources = {}) {
  return {
    databases: [],
    caches: [],
    topics: [],
    buckets: [],
    secrets: [],
    crons: [],
    ...resources,
  };
}

function backendEnv(ctx) {
  const { config, resources } = ctx;
  const env = {
    PORT: "8080",
    NODE_ENV: "production",
    APP_ID: config.app.slug,
    APP_VERSION: "${NSTACK_GIT_COMMIT:-local}",
    GIT_COMMIT: "${NSTACK_GIT_COMMIT:-local}",
    IMAGE_TAG: "${NSTACK_IMAGE_TAG:-local}",
    NSTACK_TARGET: config.deploy.target,
    NSTACK_DOMAIN: config.app.domain,
  };
  if (resources.databases.length > 0) {
    env.NSTACK_POSTGRES_PASSWORD = composeEnvValue("NSTACK_POSTGRES_PASSWORD", postgresFallbackPassword(ctx));
  }
  if (resources.caches.length > 0) {
    env.NSTACK_REDIS_PASSWORD = composeEnvValue("NSTACK_REDIS_PASSWORD", redisFallbackPassword(ctx));
  }
  if (resources.buckets.length > 0) {
    env[OBJECT_STORAGE_ACCESS_ENV] = composeEnvValue(OBJECT_STORAGE_ACCESS_ENV, objectStorageFallbackAccessKey(ctx));
    env[OBJECT_STORAGE_SECRET_ENV] = composeEnvValue(OBJECT_STORAGE_SECRET_ENV, objectStorageFallbackSecretKey(ctx));
  }
  for (const secret of resources.secrets) {
    env[secret] = `\${${secret}:?set ${secret}}`;
  }
  return env;
}

function nodeHttpHealthcheck(url) {
  return {
    test: [
      "CMD-SHELL",
      `node -e "const timeout=AbortSignal.timeout(1000); fetch('${url}', { signal: timeout }).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
    ],
    interval: "30s",
    timeout: "1s",
    retries: 3,
    start_period: "30s",
    start_interval: "1s",
  };
}

function nodeTcpHealthcheck(port) {
  return {
    test: [
      "CMD-SHELL",
      `node -e "const net=require('node:net'); const socket=net.connect(${Number(port)}, '127.0.0.1'); const done=(code)=>{socket.destroy();process.exit(code)}; socket.once('connect',()=>done(0)); socket.once('error',()=>done(1)); setTimeout(()=>done(1),1000)"`,
    ],
    interval: "30s",
    timeout: "1s",
    retries: 3,
    start_period: "30s",
    start_interval: "1s",
  };
}

function backendDependsOn(ctx, migrationServices = {}, postgresInitService = {}, postgresService = {}, redisService = {}) {
  const { resources } = ctx;
  const deps = {};
  for (const serviceName of Object.keys(migrationServices)) {
    deps[serviceName] = { condition: "service_completed_successfully" };
  }
  for (const serviceName of Object.keys(postgresInitService)) {
    if (Object.keys(migrationServices).length === 0) deps[serviceName] = { condition: "service_completed_successfully" };
  }
  for (const serviceName of Object.keys(postgresService)) {
    if (Object.keys(migrationServices).length === 0 && Object.keys(postgresInitService).length === 0) {
      deps[serviceName] = { condition: "service_healthy" };
    }
  }
  for (const serviceName of Object.keys(redisService)) {
    deps[serviceName] = { condition: "service_started" };
  }
  if (resources.topics.length > 0) deps.nsqd = { condition: "service_started" };
  return Object.keys(deps).length ? deps : undefined;
}

function inlinePostgresService(ctx) {
  const { config, infra, resources } = ctx;
  if (!pushProvision(ctx, "postgres") || !resources.databases.length || !infra?.postgres?.host) return {};
  const serviceName = postgresServiceName(config);
  return {
    [serviceName]: {
      image: POSTGRES_INIT_IMAGE,
      restart: "unless-stopped",
      environment: {
        POSTGRES_DB: infra.postgres.database || defaultPostgresDatabase(config, resources),
        POSTGRES_USER: infra.postgres.user || "nstack",
        POSTGRES_PASSWORD: composeEnvValue("NSTACK_POSTGRES_PASSWORD", postgresFallbackPassword(ctx)),
      },
      volumes: ["postgres_data:/var/lib/postgresql/data"],
      expose: ["5432"],
      networks: {
        default: {
          aliases: serviceAliases(serviceName, serviceHostAlias(infra.postgres.host)),
        },
      },
      healthcheck: {
        test: ["CMD-SHELL", "pg_isready -U \"$$POSTGRES_USER\" -d \"$$POSTGRES_DB\""],
        interval: "10s",
        timeout: "5s",
        retries: 5,
        start_period: "10s",
      },
    },
  };
}

function inlineRedisService(ctx) {
  const { config, infra, resources } = ctx;
  if (!pushProvision(ctx, "redis") || resources.caches.length === 0) return {};
  const serviceName = redisServiceName(config);
  return {
    [serviceName]: {
      image: REDIS_IMAGE,
      restart: "unless-stopped",
      entrypoint: ["/bin/sh", "-c"],
      command: ["exec dragonfly --logtostderr --dir /data --dbfilename dump --requirepass \"$$REDIS_PASSWORD\""],
      environment: {
        REDIS_PASSWORD: composeEnvValue("NSTACK_REDIS_PASSWORD", redisFallbackPassword(ctx)),
      },
      volumes: ["redis_data:/data"],
      expose: ["6379"],
      networks: {
        default: {
          aliases: serviceAliases(serviceName, serviceHostAlias(infra?.redis?.host)),
        },
      },
    },
  };
}

function postgresDatabaseInitService(ctx) {
  const { config, infra, resources } = ctx;
  if (!resources.databases.length || !infra?.postgres?.host) return {};
  const script = postgresDatabaseInitScript(infra, resources);
  if (!script) return {};
  const service = {
    image: POSTGRES_INIT_IMAGE,
    restart: "no",
    environment: {
      PGPASSWORD: composeEnvValue("NSTACK_POSTGRES_PASSWORD", postgresFallbackPassword(ctx)),
    },
    entrypoint: ["/bin/sh", "-c"],
    command: [script],
  };
  if (pushProvision(ctx, "postgres")) {
    service.depends_on = {
      [postgresServiceName(config)]: { condition: "service_healthy" },
    };
  } else {
    service.networks = {
      "dokploy-network": {},
    };
  }
  return {
    [POSTGRES_INIT_SERVICE]: service,
  };
}

function databaseMigrationServices(ctx) {
  const { config, infra, resources } = ctx;
  if (!resources.databases.length || !infra?.postgres?.host) return {};
  return Object.fromEntries(resources.databases
    .filter((database) => database.migrations)
    .map((database) => {
      const service = {
        image: ENCORE_MIGRATE_IMAGE,
        restart: "on-failure:5",
        command: [
          "-path=/migrations",
          `-database=${postgresMigrationUrl(ctx, database)}`,
          "up",
        ],
        volumes: [
          `${migrationHostPath(config, database)}:/migrations:ro`,
        ],
        depends_on: {
          [POSTGRES_INIT_SERVICE]: { condition: "service_completed_successfully" },
        },
      };
      if (!pushProvision(ctx, "postgres")) {
        service.networks = {
          "dokploy-network": {},
        };
      }
      return [migrationServiceName(database), service];
    }));
}

function migrationServiceName(database) {
  const suffix = String(database.name || "app")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "app";
  return `migrate-${suffix}`;
}

function migrationHostPath(config, database) {
  const backend = normalizeRelativePath(config.paths?.backend || "backend");
  const migrations = normalizeRelativePath(database.migrations);
  return `../../${backend}/${migrations}`;
}

function normalizeRelativePath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/g, "");
}

function postgresMigrationUrl(ctx, database) {
  const { infra, resources } = ctx;
  const databaseName = postgresPhysicalDatabaseName(infra, resources, database);
  return `postgres://${infra.postgres.user}:${composeEnvValue("NSTACK_POSTGRES_PASSWORD", postgresFallbackPassword(ctx))}@${infra.postgres.host}/${databaseName}?sslmode=disable`;
}

function postgresDatabaseInitScript(infra, resources) {
  const { host, port } = postgresConnectionParts(infra.postgres.host);
  const user = infra.postgres.user || "postgres";
  const maintenanceDatabase = infra.postgres.database || "postgres";
  const databaseNames = unique(resources.databases
    .map((database) => postgresPhysicalDatabaseName(infra, resources, database))
    .filter(Boolean));
  if (databaseNames.length === 0) return "";
  return [
    "set -eu",
    `POSTGRES_HOST=${shellQuote(host)}`,
    `POSTGRES_PORT=${shellQuote(port)}`,
    `POSTGRES_USER=${shellQuote(user)}`,
    `POSTGRES_MAINTENANCE_DB=${shellQuote(maintenanceDatabase)}`,
    `echo "waiting for postgres at ${composeShellVar("POSTGRES_HOST")}:${composeShellVar("POSTGRES_PORT")}/${composeShellVar("POSTGRES_MAINTENANCE_DB")}"`,
    `until pg_isready -h "${composeShellVar("POSTGRES_HOST")}" -p "${composeShellVar("POSTGRES_PORT")}" -U "${composeShellVar("POSTGRES_USER")}" -d "${composeShellVar("POSTGRES_MAINTENANCE_DB")}" >/dev/null 2>&1; do sleep 1; done`,
    ...databaseNames.flatMap((name) => [
      `echo "ensuring postgres database ${shellEscapeDoubleQuoted(name)}"`,
      `if [ "$(psql -v ON_ERROR_STOP=1 -h "${composeShellVar("POSTGRES_HOST")}" -p "${composeShellVar("POSTGRES_PORT")}" -U "${composeShellVar("POSTGRES_USER")}" -d "${composeShellVar("POSTGRES_MAINTENANCE_DB")}" -tAc ${shellDoubleQuote(`SELECT 1 FROM pg_database WHERE datname = ${sqlQuote(name)}`)})" != "1" ]; then`,
      `  createdb -h "${composeShellVar("POSTGRES_HOST")}" -p "${composeShellVar("POSTGRES_PORT")}" -U "${composeShellVar("POSTGRES_USER")}" --maintenance-db="${composeShellVar("POSTGRES_MAINTENANCE_DB")}" --owner "${composeShellVar("POSTGRES_USER")}" ${shellQuote(name)}`,
      "fi",
    ]),
    "echo \"postgres database init complete\"",
  ].join("\n");
}

function postgresPhysicalDatabaseName(infra, resources, database) {
  if (resources.databases.length === 1) return infra.postgres.database || database.name;
  return database.name;
}

function postgresConnectionParts(hostWithPort) {
  const text = String(hostWithPort || "");
  const match = text.match(/^(.+):([0-9]+)$/);
  if (!match) return { host: text, port: "5432" };
  return { host: match[1], port: match[2] };
}

function serviceHostAlias(hostWithPort) {
  return postgresConnectionParts(hostWithPort).host || "";
}

function serviceAliases(...values) {
  return unique(values.filter(Boolean));
}

function unique(values) {
  return [...new Set(values)];
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function shellEscapeDoubleQuoted(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`");
}

function shellDoubleQuote(value) {
  return `"${shellEscapeDoubleQuoted(value)}"`;
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function objectStorageAliases(config, buckets, objectStorageHost) {
  return [
    objectStorageHost,
    ...buckets.map((bucket) => `${objectStorageBucketName(config.app.slug, bucket)}.${objectStorageHost}`),
  ];
}

function objectStorageInitScript(config, buckets, objectStorageHost) {
  const commands = [
    `until mc alias set local http://${objectStorageHost}:${OBJECT_STORAGE_PORT} "${composeRuntimeEnv("RUSTFS_ACCESS_KEY")}" "${composeRuntimeEnv("RUSTFS_SECRET_KEY")}"; do sleep 1; done`,
    ...buckets.map((bucket) => `mc mb --ignore-existing local/${objectStorageBucketName(config.app.slug, bucket)}`),
    ...buckets
      .filter((bucket) => bucket.public)
      .map((bucket) => `mc anonymous set download local/${objectStorageBucketName(config.app.slug, bucket)}`),
  ];
  return commands.join(" && ");
}

function objectStoragePublicProxyConfig(objectStorageHost) {
  return [
    "cat > /etc/nginx/conf.d/default.conf <<'EOF'",
    "server {",
    `  listen ${OBJECT_STORAGE_PORT};`,
    "  location / {",
    "    proxy_http_version 1.1;",
    `    proxy_set_header Host ${objectStorageHost}:${OBJECT_STORAGE_PORT};`,
    "    proxy_set_header X-Forwarded-Host $$host;",
    "    proxy_set_header X-Forwarded-Proto $$scheme;",
    `    proxy_pass http://${objectStorageHost}:${OBJECT_STORAGE_PORT};`,
    "  }",
    "}",
    "EOF",
    "exec nginx -g 'daemon off;'",
  ].join("\n");
}

function postgresServiceName(config) {
  return `${config.app.slug}-postgres`;
}

function redisServiceName(config) {
  return `${config.app.slug}-redis`;
}

function defaultPostgresDatabase(config, resources) {
  if (resources.databases.length === 1 && resources.databases[0]?.name) return resources.databases[0].name;
  return String(config.app.slug || "app").replaceAll("-", "_");
}

function pushProvision(ctx, key) {
  return Boolean(ctx.pushProvision?.[key]);
}

function postgresFallbackPassword(ctx) {
  return pushProvision(ctx, "postgres") ? fallbackSecret(ctx.config, "postgres") : "";
}

function redisFallbackPassword(ctx) {
  return pushProvision(ctx, "redis") ? fallbackSecret(ctx.config, "redis") : "";
}

function objectStorageFallbackAccessKey(ctx) {
  return pushProvision(ctx, "objectStorage") ? fallbackSecret(ctx.config, "object-access") : "";
}

function objectStorageFallbackSecretKey(ctx) {
  return pushProvision(ctx, "objectStorage") ? fallbackSecret(ctx.config, "object-secret") : "";
}

function fallbackSecret(config, name) {
  const slug = String(config.app.slug || "app")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "app";
  return `nstack-${slug}-${name}`;
}

function composeEnvValue(name, fallback = "") {
  return fallback ? `\${${name}:-${fallback}}` : composeRequiredEnv(name);
}

function composeRequiredEnv(name) {
  return `\${${name}:?set ${name}}`;
}

function composeRuntimeEnv(name) {
  return `$$` + `{${name}}`;
}

function composeShellVar(name) {
  return `$$${name}`;
}
