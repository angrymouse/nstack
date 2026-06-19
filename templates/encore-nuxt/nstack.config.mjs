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
      { name: "ready", path: "/api/ready", expectStatus: 200, expectCommit: true },
    ],
  },
};
