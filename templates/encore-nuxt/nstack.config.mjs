export default {
  app: {
    name: "__APP_NAME__",
    slug: "__APP_SLUG__",
  },
  paths: {
    frontendContext: ".",
  },
  verify: {
    timeoutSeconds: 120,
    endpoints: [
      { name: "frontend", path: "/", expectStatus: 200, rejectText: ["fetch failed", "Nuxt instance unavailable"] },
      { name: "status", path: "/api/status", expectStatus: 200, expectCommit: true },
    ],
  },
};
