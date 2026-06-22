import tailwindcss from "@tailwindcss/vite";

const isProduction = process.env.NODE_ENV === "production";
const backendHost = process.env.NSTACK_BACKEND_HOST || "backend";
const siteUrl = (
  process.env.NUXT_PUBLIC_SITE_URL ||
  process.env.NSTACK_PUBLIC_SITE_URL ||
  "https://nstack.tech"
).replace(/\/$/, "");
const siteTitle = "nstack | Deployment and provisioning for Encore, Nuxt, and Dokploy";
const siteDescription =
  "nstack creates Encore plus Nuxt apps, provisions Dokploy resources, syncs the typed client, runs local dev, and owns the deploy pipeline.";
const publicApiBaseUrl =
  process.env.NUXT_PUBLIC_API_BASE_URL ||
  process.env.NUXT_PUBLIC_NSTACK_API_BASE_URL ||
  process.env.NSTACK_PUBLIC_API_BASE_URL ||
  (isProduction ? "/api" : "http://localhost:4000");
const serverApiBaseUrl =
  process.env.NUXT_API_SERVER_BASE_URL ||
  process.env.NUXT_API_INTERNAL_BASE_URL ||
  process.env.NSTACK_API_BASE_URL ||
  (isProduction ? `http://${backendHost}:8080` : "http://localhost:4000");

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  modules: ["@nuxt/content"],
  app: {
    head: {
      htmlAttrs: {
        lang: "en",
      },
      title: siteTitle,
      titleTemplate: "%s",
      meta: [
        {
          name: "description",
          content: siteDescription,
        },
        {
          name: "application-name",
          content: "nstack",
        },
        {
          name: "apple-mobile-web-app-title",
          content: "nstack",
        },
        {
          name: "theme-color",
          content: "#09090b",
        },
        {
          name: "color-scheme",
          content: "dark",
        },
        {
          name: "format-detection",
          content: "telephone=no",
        },
        {
          name: "robots",
          content:
            "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
        },
      ],
      link: [
        {
          rel: "icon",
          type: "image/png",
          href: "/favicon.png",
        },
        {
          rel: "apple-touch-icon",
          href: "/assets/nstack-logo-192.png",
        },
        {
          rel: "manifest",
          href: "/site.webmanifest",
        },
        {
          rel: "preconnect",
          href: "https://fonts.googleapis.com",
        },
        {
          rel: "preconnect",
          href: "https://fonts.gstatic.com",
          crossorigin: "",
        },
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=Recursive:CASL,CRSV,MONO,slnt,wght@0..1,0..1,0..1,-15..0,300..1000&display=swap",
        },
      ],
    },
  },
  devtools: {
    enabled: false,
  },
  future: {
    compatibilityVersion: 4,
  },
  experimental: {
    buildCache: true,
  },
  sourcemap: false,
  css: ["~/assets/css/main.css"],
  vite: {
    plugins: [tailwindcss()],
    build: {
      reportCompressedSize: false,
    },
  },
  nitro: {
    preset: "node-server",
    sourceMap: false,
  },
  runtimeConfig: {
    apiServerBaseUrl: serverApiBaseUrl,
    public: {
      apiBaseUrl: publicApiBaseUrl,
      siteUrl,
    },
  },
  typescript: {
    strict: true,
  },
});
