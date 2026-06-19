export const OBJECT_STORAGE_SERVICE_NAME = "rustfs";
export const OBJECT_STORAGE_PUBLIC_SERVICE_NAME = "rustfs-public";
export const OBJECT_STORAGE_INIT_SERVICE_NAME = "rustfs-init";
export const OBJECT_STORAGE_IMAGE = "rustfs/rustfs:latest";
export const OBJECT_STORAGE_INIT_IMAGE = "minio/mc:latest";
export const OBJECT_STORAGE_PUBLIC_IMAGE = "nginx:1.27-alpine";
export const OBJECT_STORAGE_PORT = 9000;
export const OBJECT_STORAGE_ACCESS_ENV = "NSTACK_MINIO_ACCESS_KEY";
export const OBJECT_STORAGE_SECRET_ENV = "NSTACK_MINIO_SECRET_KEY";

export function objectStorageServiceHost(config) {
  return `${config.app.slug}-rustfs`;
}

export function legacyObjectStorageServiceHost(config) {
  return `${config.app.slug}-minio`;
}

export function objectStorageInfra(config, current = {}, defaults = {}) {
  const appName = normalizedObjectStorageAppName(config, current.appName);
  const host = normalizedObjectStorageHost(config, current.host, appName);
  return {
    appName,
    host,
    endpoint: normalizedObjectStorageEndpoint(config, current.endpoint, host),
    region: current.region || defaults.region || "us-east-1",
    accessKey: current.accessKey || defaults.accessKey || "",
    secretKey: current.secretKey || defaults.secretKey || "",
  };
}

function normalizedObjectStorageAppName(config, value = "") {
  const current = String(value || "");
  if (!current || current === legacyObjectStorageServiceHost(config)) return objectStorageServiceHost(config);
  return current;
}

function normalizedObjectStorageHost(config, value = "", appName = objectStorageServiceHost(config)) {
  const current = String(value || "");
  if (!current || current === `${legacyObjectStorageServiceHost(config)}:${OBJECT_STORAGE_PORT}`) {
    return `${appName}:${OBJECT_STORAGE_PORT}`;
  }
  return current;
}

function normalizedObjectStorageEndpoint(config, value = "", host = `${objectStorageServiceHost(config)}:${OBJECT_STORAGE_PORT}`) {
  const current = String(value || "");
  if (!current || current === `http://${legacyObjectStorageServiceHost(config)}:${OBJECT_STORAGE_PORT}`) {
    return `http://${host}`;
  }
  return current;
}
