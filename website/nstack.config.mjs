export default {
  app: {
    name: "nstack",
    slug: "nstack",
    domain: "nstack.tech",
  },
  paths: {
    frontendContext: ".",
  },
  deploy: {
    source: {
      sourceType: "gitea",
      repository: "https://git.nik.technology/angrymouse/nstack.git",
      branch: "main",
      composePath: "website/deploy/nstack/compose.dokploy.yaml",
      watchPaths: ["website/**"],
    },
  },
  verify: {
    timeoutSeconds: 120,
    endpoints: [
      { name: "ready", path: "/api/ready", expectStatus: 200 },
    ],
  },
};
