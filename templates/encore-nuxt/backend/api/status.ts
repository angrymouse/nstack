import { api } from "encore.dev/api";
import { db } from "./db";

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
    app: process.env.APP_ID || "__APP_SLUG__",
    commit: process.env.GIT_COMMIT || "",
    image_tag: process.env.IMAGE_TAG || "",
    uptime_seconds: Math.floor(process.uptime()),
    ok: true,
  }),
);

export const status = api(
  { expose: true, method: "GET", path: "/status" },
  async (): Promise<StatusResponse> => {
    const row = await db.queryRow<{ ok: number }>`SELECT 1 AS ok`;
    return {
      app: process.env.APP_ID || "__APP_SLUG__",
      commit: process.env.GIT_COMMIT || "",
      image_tag: process.env.IMAGE_TAG || "",
      database_ok: row?.ok === 1,
      uptime_seconds: Math.floor(process.uptime()),
    };
  },
);
