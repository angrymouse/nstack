const isProduction = process.env.NODE_ENV === "production";
const backendHost = process.env.NSTACK_BACKEND_HOST || "backend";
const publicApiBaseUrl =
  process.env.NUXT_PUBLIC_API_BASE_URL ||
  process.env.NUXT_PUBLIC_NSTACK_API_BASE_URL ||
  process.env.NSTACK_PUBLIC_API_BASE_URL ||
  "/api";
const serverApiBaseUrl =
  process.env.NUXT_API_SERVER_BASE_URL ||
  process.env.NUXT_API_INTERNAL_BASE_URL ||
  process.env.NSTACK_API_BASE_URL ||
  (isProduction ? `http://${backendHost}:8080` : "http://localhost:4000");

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  future: {
    compatibilityVersion: 4,
  },
  experimental: {
    buildCache: true,
  },
  sourcemap: false,
  vite: {
    build: {
      reportCompressedSize: false,
    },
  },
  nitro: {
    preset: "node-server",
    sourceMap: false,
    devProxy: {
      "/api": {
        target: serverApiBaseUrl,
        changeOrigin: true,
      },
    },
  },
  runtimeConfig: {
    apiServerBaseUrl: serverApiBaseUrl,
    public: {
      apiBaseUrl: publicApiBaseUrl,
    },
  },
  typescript: {
    strict: true,
  },
});
