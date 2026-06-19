import { formatDotEnv } from "./util.js";

export function composeEnvironmentValues({ resources, infra, secretEnv, buildEnv = {} }) {
  const databases = resources.databases || [];
  const caches = resources.caches || [];
  const buckets = resources.buckets || [];
  return {
    ...buildEnv,
    ...(databases.length > 0 ? { NSTACK_POSTGRES_PASSWORD: infra.postgres.password } : {}),
    ...(caches.length > 0 ? { NSTACK_REDIS_PASSWORD: infra.redis.password } : {}),
    ...(buckets.length > 0 ? {
      NSTACK_MINIO_ACCESS_KEY: infra.objectStorage.accessKey,
      NSTACK_MINIO_SECRET_KEY: infra.objectStorage.secretKey,
    } : {}),
    ...secretEnv,
  };
}

export function renderComposeEnvironment(ctx) {
  return formatDotEnv(composeEnvironmentValues(ctx));
}
