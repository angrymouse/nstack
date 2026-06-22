---
title: Local development
description: Run Encore and Nuxt locally with generated client sync.
navigation:
  title: Local development
---

# Local development

Use `nstack dev` from the generated app directory.

```bash
nstack dev
```

The command rebuilds the generated Encore client, starts Encore, starts Nuxt, and keeps the local process layout consistent for humans and agents.

## Generated client

The generated client lives in the frontend app. Nuxt imports it instead of hand-written API wrappers, so TypeScript sees backend changes after regeneration.

```txt
frontend/app/generated/encore-client.ts
```

## Agent execution

Use `nstack devexec` when an agent needs to run a script inside the prepared development environment.

```bash
nstack devexec 'console.log("ready")'
```

## Local files

Local config and secrets are kept in `.nstack/`.
