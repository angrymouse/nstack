import Client, { type ClientOptions } from "../generated/encore-client";

function clean(value: unknown): string {
  return String(value || "").replace(/\/+$/, "");
}

export function apiBaseUrl(): string {
  const config = useRuntimeConfig();
  if (import.meta.server) {
    const backendHost = process.env.NSTACK_BACKEND_HOST || "backend";
    return clean(config.apiServerBaseUrl) || `http://${backendHost}:8080`;
  }
  return clean(config.public.apiBaseUrl) || "/api";
}

export function apiClient(options: ClientOptions = {}): Client {
  const requestInit = {
    ...options.requestInit,
    headers: {
      ...serverRequestHeaders(),
      ...(options.requestInit?.headers || {}),
    },
  };
  return new Client(apiBaseUrl(), { ...options, requestInit });
}

function serverRequestHeaders(): Record<string, string> {
  if (!import.meta.server) return {};
  return Object.fromEntries(
    Object.entries(useRequestHeaders(["authorization", "cookie"]))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
}
