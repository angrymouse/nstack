import { objectStorageBucketName } from "../resource-names.js";

export function renderEncoreInfra(ctx) {
  const { config, infra } = ctx;
  const resources = normalizeResources(ctx.resources);
  const materializeSecrets = Boolean(ctx.materializeSecrets);
  const baseUrl = `https://${config.app.domain}/api`;
  const appId = config.app.slug;
  const gatewayNames = hostedGatewayNames(resources);
  const result = {
    $schema: "https://encore.dev/schemas/infra.schema.json",
    metadata: {
      app_id: appId,
      env_name: config.deploy.target,
      env_type: "production",
      cloud: "local",
      base_url: baseUrl,
    },
    graceful_shutdown: { total: 30 },
    hosted_services: resources.services.length ? resources.services.map((service) => service.name) : undefined,
    hosted_gateways: gatewayNames.length ? gatewayNames : undefined,
    cors: {
      allow_origins_with_credentials: [`https://${config.app.domain}`],
      allow_headers: ["Authorization", "Content-Type", "X-Requested-With"],
      expose_headers: ["x-encore-trace-id", "X-Request-Id"],
    },
    secrets: Object.fromEntries(resources.secrets.map((secret) => [secret, { $env: secret }])),
  };

  if (resources.databases.length > 0) {
    result.sql_servers = [
      {
        host: infra.postgres.host,
        tls_config: { disabled: true },
        databases: Object.fromEntries(resources.databases.map((database) => [
          postgresDatabaseName(resources, infra, database),
          {
            name: resources.databases.length === 1 ? infra.postgres.database : database.name,
            username: infra.postgres.user,
            password: infraSecret(materializeSecrets, infra.postgres.password, "NSTACK_POSTGRES_PASSWORD", "Postgres password"),
            min_connections: 1,
            max_connections: 30,
          },
        ])),
      },
    ];
  }

  if (resources.topics.length > 0) {
    result.pubsub = [
      {
        type: "nsq",
        hosts: `${appId}-nsqd:4150`,
        topics: Object.fromEntries(resources.topics.map((topic) => [
          topic.name,
          {
            name: `${appId}-${topic.name}`,
            subscriptions: Object.fromEntries((topic.subscriptions || []).map((subscription) => [
              subscription.name,
              { name: `${appId}-${subscription.name}` },
            ])),
          },
        ])),
      },
    ];
  }

  if (resources.buckets.length > 0) {
    result.object_storage = [
      {
        type: "s3",
        access_key_id: infraSecret(materializeSecrets, infra.objectStorage.accessKey, "NSTACK_MINIO_ACCESS_KEY", "object storage access key"),
        secret_access_key: infraSecret(materializeSecrets, infra.objectStorage.secretKey, "NSTACK_MINIO_SECRET_KEY", "object storage secret key"),
        region: infra.objectStorage.region,
        endpoint: infra.objectStorage.endpoint,
        buckets: Object.fromEntries(resources.buckets.map((bucket) => [
          bucket.name,
          {
            name: objectStorageBucketName(appId, bucket),
            ...(bucket.public ? { public_base_url: `https://${config.app.domain}/objects/${objectStorageBucketName(appId, bucket)}` } : {}),
          },
        ])),
      },
    ];
  }

  if (resources.caches.length > 0) {
    result.redis = Object.fromEntries(resources.caches.map((cache, index) => [
      cache.name,
      {
        host: infra.redis.host,
        database_index: index,
        key_prefix: `${appId}:${cache.name}:`,
        in_memory: false,
        tls_config: { disabled: true },
        auth: {
          type: "auth_string",
          auth_string: infraSecret(materializeSecrets, infra.redis.password, "NSTACK_REDIS_PASSWORD", "Redis password"),
        },
      },
    ]));
  }

  return `${JSON.stringify(stripUndefined(result), null, 2)}\n`;
}

function infraSecret(materialize, value, envName, label) {
  if (!materialize) return { $env: envName };
  if (!value) throw new Error(`Cannot materialize ${label}; ${envName} is missing from local infrastructure state.`);
  return String(value);
}

function normalizeResources(resources = {}) {
  return {
    services: [],
    databases: [],
    topics: [],
    buckets: [],
    caches: [],
    secrets: [],
    ...resources,
  };
}

function hostedGatewayNames(resources) {
  return [...new Set((resources.metadata?.gateways || [])
    .map((gateway) => typeof gateway === "string" ? gateway : (gateway.encore_name || gateway.name || ""))
    .filter(Boolean))];
}

function postgresDatabaseName(resources, _infra, database) {
  return database.name;
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, stripUndefined(item)]));
}
