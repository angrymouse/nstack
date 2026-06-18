function clean(value: unknown): string {
  return String(value || "").replace(/\/+$/, "");
}

export function apiBaseUrl(): string {
  const config = useRuntimeConfig();
  if (import.meta.server) {
    return clean(config.apiServerBaseUrl) || "http://backend:8080";
  }
  return clean(config.public.apiBaseUrl) || "/api";
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`);
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  return await response.json() as T;
}
