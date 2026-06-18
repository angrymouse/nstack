import { formatDotEnv } from "./util.js";

export function composeEnvironmentValues({ resources, infra, secretEnv }) {
  return {
    ...(resources.databases.length > 0 ? { NSTACK_POSTGRES_PASSWORD: infra.postgres.password } : {}),
    ...(resources.caches.length > 0 ? { NSTACK_REDIS_PASSWORD: infra.redis.password } : {}),
    ...secretEnv,
  };
}

export function renderComposeEnvironment(ctx) {
  return formatDotEnv(composeEnvironmentValues(ctx));
}
