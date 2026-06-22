---
title: Overview
description: What nstack manages for Encore, Nuxt, and Dokploy apps.
navigation:
  title: Overview
---

# nstack docs

nstack is a CLI for creating, running, provisioning, and deploying Encore + Nuxt apps on Dokploy.

It creates the app structure, keeps the generated Encore client synced, runs the backend and frontend locally, prepares Dokploy deployment files, provisions resources, and runs the target deploy pipeline.

## What nstack manages

- Encore API source and resource declarations.
- Nuxt app source and generated Encore client code.
- Local setup for dependencies, config, and development commands.
- Dokploy services, routes, domains, resources, and deployment output.
- Target operations such as deploys, logs, status, backups, pulls, and rollback.

## Typical project shape

```txt
my-app/
  backend/
    api/
      status.ts
      db.ts
      gateway.ts
    encore.app
  frontend/
    app/
      pages/index.vue
      generated/encore-client.ts
      utils/api.ts
    nuxt.config.ts
  nstack.config.mjs
  pnpm-workspace.yaml
  package.json
```

## Read next

Start with [Getting started](/docs/getting-started) for a new app, then read [Deployment](/docs/deployment) before wiring Dokploy targets.
