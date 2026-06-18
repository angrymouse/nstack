export function renderEncoreInfra(ctx) {
  const { config, resources, infra } = ctx;
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
            name: database.name,
            username: infra.postgres.user,
            password: { $env: "NSTACK_POSTGRES_PASSWORD" },
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
        hosts: "nsqd:4150",
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

  if (resources.caches.length > 0) {
    result.redis = Object.fromEntries(resources.caches.map((cache, index) => [
      cache.name,
      {
        host: infra.redis.host,
        database_index: index,
        key_prefix: `${appId}:${cache.name}:`,
        auth: {
          type: "auth_string",
          auth_string: { $env: "NSTACK_REDIS_PASSWORD" },
        },
      },
    ]));
  }

  return `${JSON.stringify(stripUndefined(result), null, 2)}\n`;
}

function hostedGatewayNames(resources) {
  return [...new Set((resources.metadata?.gateways || [])
    .map((gateway) => typeof gateway === "string" ? gateway : (gateway.encore_name || gateway.name || ""))
    .filter(Boolean))];
}

function postgresDatabaseName(resources, infra, database) {
  if (resources.databases.length === 1) return infra.postgres.database;
  return database.name;
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, stripUndefined(item)]));
}
