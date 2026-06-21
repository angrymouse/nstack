import { api } from "encore.dev/api";

interface StatusResponse {
  app: string;
  commit: string;
  image_tag: string;
  database_ok: boolean;
  uptime_seconds: number;
}

interface ReadyResponse {
  app: string;
  commit: string;
  image_tag: string;
  uptime_seconds: number;
  ok: boolean;
}

export const ready = api(
  { expose: true, method: "GET", path: "/ready" },
  async (): Promise<ReadyResponse> => ({
    app: process.env.APP_ID || "nstack",
    commit: process.env.GIT_COMMIT || "",
    image_tag: process.env.IMAGE_TAG || "",
    uptime_seconds: Math.floor(process.uptime()),
    ok: true,
  }),
);

export const status = api(
  { expose: true, method: "GET", path: "/status" },
  async (): Promise<StatusResponse> => ({
    app: process.env.APP_ID || "nstack",
    commit: process.env.GIT_COMMIT || "",
    image_tag: process.env.IMAGE_TAG || "",
    database_ok: true,
    uptime_seconds: Math.floor(process.uptime()),
  }),
);
